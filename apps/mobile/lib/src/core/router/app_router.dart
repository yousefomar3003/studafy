import 'package:go_router/go_router.dart';

import '../../features/auth/presentation/login_screen.dart';
import '../../features/home/presentation/home_screen.dart';
import '../../features/notifications/presentation/notification_destination_screen.dart';
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

      // Notification deep-link destinations. Each maps to the placeholder
      // screen until the real feature screen is built. The route path comes
      // from the FCM data payload `route` field, which is set server-side by
      // the notification templates registry.
      GoRoute(
        path: '/courses/:courseId/grades',
        builder: (context, state) => NotificationDestinationScreen(
          route: state.matchedLocation,
        ),
      ),
      GoRoute(
        path: '/courses/:courseId/attendance',
        builder: (context, state) => NotificationDestinationScreen(
          route: state.matchedLocation,
        ),
      ),
      GoRoute(
        path: '/announcements',
        builder: (context, state) => NotificationDestinationScreen(
          route: state.matchedLocation,
        ),
      ),
      GoRoute(
        path: '/courses/:courseId',
        builder: (context, state) => NotificationDestinationScreen(
          route: state.matchedLocation,
        ),
      ),
      GoRoute(
        path: '/courses/:courseId/assignments/:assignmentId',
        builder: (context, state) => NotificationDestinationScreen(
          route: state.matchedLocation,
        ),
      ),
      GoRoute(
        path: '/courses/:courseId/discussions/:discussionId',
        builder: (context, state) => NotificationDestinationScreen(
          route: state.matchedLocation,
        ),
      ),
      GoRoute(
        path: '/groups/:groupId',
        builder: (context, state) => NotificationDestinationScreen(
          route: state.matchedLocation,
        ),
      ),
      GoRoute(
        path: '/certificates/:certificateId',
        builder: (context, state) => NotificationDestinationScreen(
          route: state.matchedLocation,
        ),
      ),
      GoRoute(
        path: '/support/tickets/:ticketId',
        builder: (context, state) => NotificationDestinationScreen(
          route: state.matchedLocation,
        ),
      ),
    ],
  );
}
