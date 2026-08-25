import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'auth_notifier.dart';
import 'auth_state.dart';
import '../router/route_paths.dart';

/// GoRouter redirect that enforces authentication.
///
/// Reads [authStatusProvider] and redirects to the login screen when the user
/// is unauthenticated. Shows a loading indicator while the session is being
/// restored from secure storage.
Future<String?> authGuard(BuildContext context, GoRouterState state) async {
  final container = ProviderScope.containerOf(context);
  final status = container.read(authStatusProvider);

  final isOnLoginRoute = state.matchedLocation == RoutePaths.login;

  switch (status) {
    case AuthStatus.loading:
      return isOnLoginRoute ? null : RoutePaths.login;

    case AuthStatus.unauthenticated:
      return isOnLoginRoute ? null : RoutePaths.login;

    case AuthStatus.authenticated:
      return isOnLoginRoute ? RoutePaths.home : null;
  }
}
