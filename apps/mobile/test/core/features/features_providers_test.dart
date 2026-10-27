import 'dart:convert';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/auth/auth_notifier.dart';
import 'package:studafy_mobile/src/core/auth/auth_state.dart';
import 'package:studafy_mobile/src/core/features/feature_gate.dart';
import 'package:studafy_mobile/src/core/features/features_providers.dart';
import 'package:studafy_mobile/src/core/features/my_features.dart';
import 'package:studafy_mobile/src/core/realtime/realtime_client.dart';
import 'package:studafy_mobile/src/core/realtime/realtime_providers.dart';

import '../../support/pump_studafy_app.dart';
import '../realtime/fake_realtime_socket.dart';
import 'feature_fixtures.dart';

/// The features provider and what keeps it current: it reads `GET /api/me/features` through the
/// client, decides each feature's gate, and is re-read on app resume, on a `userEntitlement.changed`
/// event for this person (not anyone else's), and when the realtime socket reconnects -- driven
/// here through the real [RealtimeClient] over a fake socket.
class _CountingClient implements MyFeaturesClient {
  _CountingClient(this.json);

  Map<String, dynamic> json;
  int calls = 0;

  @override
  Future<MyFeatures> fetch() async {
    calls += 1;
    return MyFeatures.fromJson(json);
  }
}

Future<void> _settle() => Future<void>.delayed(Duration.zero);

void main() {
  late _CountingClient client;
  late FakeRealtimeSocketFactory sockets;
  late RealtimeClient realtime;

  /// [signedIn] false skips the session (and its refresh timer) for the lifecycle test, which runs
  /// in a widget test's fake clock and needs no realtime.
  Future<ProviderContainer> container({bool signedIn = true}) async {
    final container = ProviderContainer(
      overrides: [
        myFeaturesClientProvider.overrideWithValue(client),
        if (signedIn) ...[
          authSessionProvider.overrideWithValue(
            await fakeAuthenticatedSession(
              roles: ['STUDENT'],
              userId: 'user-1',
            ),
          ),
          authStatusProvider.overrideWithValue(AuthStatus.authenticated),
          realtimeClientProvider.overrideWithValue(realtime),
        ] else
          authStatusProvider.overrideWithValue(AuthStatus.unauthenticated),
      ],
    );
    addTearDown(container.dispose);
    return container;
  }

  var eventCount = 0;
  void emitEvent(String type, Map<String, dynamic> payload) {
    eventCount += 1;
    sockets.created.last.emitMessage(
      jsonEncode({
        'id':
            '3fa85f64-5717-4562-b3fc-${eventCount.toString().padLeft(12, '0')}',
        'type': type,
        'room': 'school:s-1:user:user-1',
        'payload': payload,
        'publishedAt': '2026-10-27T12:00:00.000Z',
      }),
    );
  }

  setUp(() {
    client = _CountingClient({
      'schoolName': 'Alpha Academy',
      'features': [featureJson(reason: 'not_included', schoolOffers: true)],
    });
    sockets = FakeRealtimeSocketFactory();
    realtime = RealtimeClient(
      baseUrl: Uri.parse('ws://localhost:3001'),
      getToken: () async => 'token',
      socketFactory: sockets.call,
      createTimer: FakeTimerScheduler().call,
      lifecycleObserverFactory: ({required onResume, required onPause}) =>
          _NoopObserver(),
    );
    addTearDown(realtime.dispose);
  });

  test('reads the features and decides each gate from them', () async {
    final c = await container();
    final features = await c.read(myFeaturesProvider.future);
    expect(features.schoolName, 'Alpha Academy');
    expect(
      c.read(featureGateProvider(FeatureKeys.aiTutor)).value,
      isA<FeatureAskSchool>(),
    );
    expect(client.calls, 1);
  });

  test(
    "re-reads on this person's userEntitlement.changed, not on someone else's",
    () async {
      final c = await container();
      c.listen(myFeaturesProvider, (_, _) {});
      // Listened, as the app root watches it: Riverpod pauses an unlistened provider's listeners.
      c.listen(featuresAutoRefreshProvider, (_, _) {});
      await c.read(myFeaturesProvider.future);
      realtime.connect();
      await _settle();
      sockets.created.last.completeReady();
      await _settle();
      await c.read(myFeaturesProvider.future);
      final afterConnect = client.calls;

      // Someone else's change: nothing to re-read.
      emitEvent(userEntitlementChangedEvent, {
        'schoolId': 's-1',
        'userId': 'user-2',
      });
      await _settle();
      await c.read(myFeaturesProvider.future);
      expect(client.calls, afterConnect);

      // A seat was assigned to this person: the gate flips without them doing anything.
      client.json = {
        'schoolName': 'Alpha Academy',
        'features': [
          featureJson(
            active: true,
            sources: [grant('school_license', limit: 300)],
            schoolSeat: true,
          ),
        ],
      };
      emitEvent(userEntitlementChangedEvent, {
        'schoolId': 's-1',
        'userId': 'user-1',
      });
      await _settle();
      await c.read(myFeaturesProvider.future);
      expect(client.calls, afterConnect + 1);
      expect(
        c.read(featureGateProvider(FeatureKeys.aiTutor)).value,
        isA<FeatureCovered>(),
      );

      // Other events are not this provider's business.
      emitEvent('grades.published', {'studentId': 'x'});
      await _settle();
      expect(client.calls, afterConnect + 1);
    },
  );

  test(
    're-reads when the socket (re)connects: events sent while it was down are lost',
    () async {
      final c = await container();
      c.listen(myFeaturesProvider, (_, _) {});
      // Listened, as the app root watches it: Riverpod pauses an unlistened provider's listeners.
      c.listen(featuresAutoRefreshProvider, (_, _) {});
      await c.read(myFeaturesProvider.future);
      expect(client.calls, 1);

      realtime.connect();
      await _settle();
      sockets.created.last.completeReady();
      await _settle();
      await c.read(myFeaturesProvider.future);
      expect(client.calls, 2);
    },
  );

  test('re-reads when the app comes back to the foreground', () async {
    final binding = TestWidgetsFlutterBinding.ensureInitialized();
    final c = await container(signedIn: false);
    c.listen(myFeaturesProvider, (_, _) {});
    // Listened, as the app root watches it: Riverpod pauses an unlistened provider's listeners.
    c.listen(featuresAutoRefreshProvider, (_, _) {});
    await c.read(myFeaturesProvider.future);
    expect(client.calls, 1);

    for (final state in [
      AppLifecycleState.inactive,
      AppLifecycleState.hidden,
      AppLifecycleState.paused,
      AppLifecycleState.hidden,
      AppLifecycleState.inactive,
      AppLifecycleState.resumed,
    ]) {
      binding.handleAppLifecycleStateChanged(state);
    }
    await _settle();
    await c.read(myFeaturesProvider.future);
    expect(client.calls, 2);
  });
}

class _NoopObserver implements AppLifecycleObserver {
  @override
  void dispose() {}
}
