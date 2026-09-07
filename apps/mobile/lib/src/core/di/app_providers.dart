import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../auth/auth_providers.dart';
import '../config/app_config.dart';
import '../network/network_config.dart';
import '../router/app_router.dart';
import '../update/update_providers.dart';

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
  // flight, which can leave the app stuck on a blank page. `refreshListenable` re-runs the
  // redirect on this same instance whenever auth status flips (restore completes, login, logout),
  // and also when the forced-update decision resolves — so a build below the floor is pinned to
  // /forced-update the moment `updateStatusProvider` reports it.
  final routerRefresh = _RouterRefreshListenable(ref);
  ref.onDispose(routerRefresh.dispose);

  return createAppRouter(appConfig: appConfig, refreshListenable: routerRefresh);
});

/// Bridges the providers the router's redirect reads — [authStatusProvider] and
/// [updateStatusProvider] — to a [Listenable] `GoRouter.refreshListenable` can observe, since
/// Riverpod providers aren't `Listenable` themselves.
class _RouterRefreshListenable extends ChangeNotifier {
  _RouterRefreshListenable(Ref ref) {
    ref.listen(authStatusProvider, (previous, next) => notifyListeners());
    ref.listen(updateStatusProvider, (previous, next) => notifyListeners());
  }
}
