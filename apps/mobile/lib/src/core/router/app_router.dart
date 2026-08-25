import 'package:go_router/go_router.dart';

import '../../features/auth/presentation/login_screen.dart';
import '../../features/home/presentation/home_screen.dart';
import '../auth/auth_guard.dart';
import '../config/app_config.dart';
import '../config/app_environment.dart';
import 'route_paths.dart';

GoRouter createAppRouter({required AppConfig appConfig}) {
  return GoRouter(
    debugLogDiagnostics: appConfig.environment == AppEnvironment.dev,
    initialLocation: RoutePaths.home,
    redirect: (context, state) => authGuard(context, state),
    routes: [
      GoRoute(
        path: RoutePaths.login,
        builder: (context, state) => const LoginScreen(),
      ),
      GoRoute(
        path: RoutePaths.home,
        builder: (context, state) => const HomeScreen(),
      ),
    ],
  );
}
