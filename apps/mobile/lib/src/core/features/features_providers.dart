import 'package:dio/dio.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../auth/auth_notifier.dart';
import '../auth/auth_state.dart';
import '../auth/authenticated_dio.dart';
import '../realtime/realtime_client.dart';
import '../realtime/realtime_providers.dart';
import 'feature_gate.dart';
import 'my_features.dart';

/// `GET /api/me/features` on the app's authenticated [Dio] (bearer, 401 recovery, error mapping).
class MyFeaturesClient {
  const MyFeaturesClient(this._dio);

  final Dio _dio;

  Future<MyFeatures> fetch() async {
    final response = await _dio.get<Map<String, dynamic>>('/api/me/features');
    return MyFeatures.fromJson(response.data ?? const {});
  }
}

final myFeaturesClientProvider = Provider<MyFeaturesClient>(
  (ref) => MyFeaturesClient(authenticatedDio(ref)),
);

/// The signed-in person's paid features. Kept alive for the session and re-read by
/// [featuresAutoRefreshProvider] (app resume, entitlement changes, reconnects) and after a store
/// purchase (`AiStoreController`). Rebuilt on sign-in and sign-out, so one person's features never
/// outlive their session.
final myFeaturesProvider = FutureProvider<MyFeatures>((ref) async {
  ref.watch(authStatusProvider);
  return ref.watch(myFeaturesClientProvider).fetch();
});

/// One feature's [FeatureGateState]. Loading and error pass through: a screen decides what to show
/// while the list loads, and the API still refuses whatever the list got wrong.
final featureGateProvider =
    Provider.family<AsyncValue<FeatureGateState>, String>((ref, key) {
      return ref
          .watch(myFeaturesProvider)
          .whenData((features) => featureGateStateOf(features, key));
    });

/// The person pays for (or is trialling) at least one feature themselves -- a school seat alone
/// does not count. False while the list loads or when it fails.
final hasPersonalSubscriptionProvider = Provider<bool>((ref) {
  final features = ref.watch(myFeaturesProvider).value;
  if (features == null) return false;
  return features.features.values.any(
    (f) => f.active && f.sources.any((s) => s.source.isPersonal),
  );
});

/// The domain event the API emits whenever a person's grants change (a seat assigned or freed, a
/// license activated, suspended or ended); the realtime gateway delivers it to that person's room.
const userEntitlementChangedEvent = 'userEntitlement.changed';

/// The shortest gap between two re-reads of [myFeaturesProvider] triggered by the app coming back
/// to the foreground. Switching apps several times a minute should not re-read each time.
const featuresResumeRefreshInterval = Duration(minutes: 5);

/// The clock [featuresAutoRefreshProvider] throttles resume re-reads with. Override in tests.
final featuresClockProvider = Provider<DateTime Function()>((ref) => DateTime.now);

/// Keeps [myFeaturesProvider] current without the person doing anything: re-reads it when the app
/// comes back to the foreground (a purchase or a seat may have happened elsewhere) — at most once
/// per [featuresResumeRefreshInterval], counted from the last read this provider caused or the
/// session start — when the realtime gateway says this person's entitlements changed, and when the
/// socket reconnects (events sent while it was down are not replayed). Watched once by the app
/// root. The AI tab's status re-reads with the features list (`aiHubStatusProvider`), so it shares
/// this throttle.
final featuresAutoRefreshProvider = Provider<void>((ref) {
  final clock = ref.watch(featuresClockProvider);
  var lastRefresh = clock();
  void refresh() {
    lastRefresh = clock();
    ref.invalidate(myFeaturesProvider);
  }

  final lifecycle = AppLifecycleListener(
    onResume: () {
      if (clock().difference(lastRefresh) >= featuresResumeRefreshInterval) refresh();
    },
  );
  ref.onDispose(lifecycle.dispose);

  // The realtime half only for a signed-in session: the gateway needs its token, and nothing before
  // sign-in has features to refresh. Re-run on sign-in and sign-out.
  if (ref.watch(authStatusProvider) != AuthStatus.authenticated) return;

  ref.listen(realtimeEventsProvider, (_, next) {
    final envelope = next.value;
    if (envelope?.type != userEntitlementChangedEvent) return;
    final payload = envelope!.payload;
    final userId = payload is Map ? payload['userId'] : null;
    if (userId == ref.read(authSessionProvider).userId) refresh();
  });

  ref.listen(realtimeConnectionStatusProvider, (previous, next) {
    if (next == RealtimeConnectionStatus.connected &&
        previous != RealtimeConnectionStatus.connected) {
      refresh();
    }
  });
});
