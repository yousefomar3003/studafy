import 'package:go_router/go_router.dart';

import '../../features/home/presentation/home_screen.dart';
import '../config/app_config.dart';
import '../config/app_environment.dart';
import 'route_paths.dart';

GoRouter createAppRouter({required AppConfig appConfig}) {
  return GoRouter(
    debugLogDiagnostics: appConfig.environment == AppEnvironment.dev,
    initialLocation: RoutePaths.home,
    routes: [
      GoRoute(
        path: RoutePaths.home,
        builder: (context, state) => const HomeScreen(),
      ),
    ],
  );
}
