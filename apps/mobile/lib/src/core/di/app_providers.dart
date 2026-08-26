import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../auth/auth_providers.dart';
import '../config/app_config.dart';
import '../network/network_config.dart';
import '../router/app_router.dart';

final appConfigProvider = Provider<AppConfig>((ref) {
  throw StateError('AppConfig must be provided during app bootstrap.');
});

final networkConfigProvider = Provider<NetworkConfig>((ref) {
  final appConfig = ref.watch(appConfigProvider);

  return NetworkConfig(
    apiBaseUrl: appConfig.apiBaseUrl,
    realtimeBaseUrl: appConfig.realtimeBaseUrl,
  );
});

final routerProvider = Provider<GoRouter>((ref) {
  final appConfig = ref.watch(appConfigProvider);

  // One GoRouter for the provider's lifetime: recreating it on every auth change (rather than
  // just re-running its redirect) abandons whatever async route resolution was already in
  // flight, which can leave the app stuck on a blank page. `refreshListenable` re-runs
  // `authGuard`'s redirect on this same instance whenever auth status flips (restore
  // completes, login, logout) instead.
  final authRefresh = _AuthRefreshListenable(ref);
  ref.onDispose(authRefresh.dispose);

  return createAppRouter(appConfig: appConfig, refreshListenable: authRefresh);
});

/// Bridges [authStatusProvider] changes to a [Listenable] `GoRouter.refreshListenable` can
/// observe — Riverpod providers aren't `Listenable` themselves.
class _AuthRefreshListenable extends ChangeNotifier {
  _AuthRefreshListenable(Ref ref) {
    ref.listen(authStatusProvider, (previous, next) => notifyListeners());
  }
}
