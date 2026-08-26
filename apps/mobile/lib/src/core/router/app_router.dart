import 'package:flutter/foundation.dart';
import 'package:go_router/go_router.dart';

import '../../features/auth/presentation/login_screen.dart';
import '../../features/shell/presentation/app_shell.dart';
import '../auth/auth_guard.dart';
import '../config/app_config.dart';
import '../config/app_environment.dart';
import 'route_paths.dart';

GoRouter createAppRouter({required AppConfig appConfig, Listenable? refreshListenable}) {
  return GoRouter(
    debugLogDiagnostics: appConfig.environment == AppEnvironment.dev,
    initialLocation: RoutePaths.home,
    redirect: (context, state) => authGuard(context, state),
    refreshListenable: refreshListenable,
    routes: [
      GoRoute(
        path: RoutePaths.login,
        builder: (context, state) => const LoginScreen(),
      ),
      GoRoute(
        path: RoutePaths.home,
        builder: (context, state) => const AppShell(),
      ),
    ],
  );
}
