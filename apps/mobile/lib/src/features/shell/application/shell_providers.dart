import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/auth_providers.dart';
import '../../../core/auth/auth_state.dart';
import '../domain/shell_role.dart';

/// The current session's role claims, or empty when not authenticated.
///
/// [AuthSession] itself isn't observable, so this reads through [authStatusProvider] — the
/// only thing that changes the session's roles (login, logout, restore-on-boot) also flips
/// that status — to know when to re-read [AuthSession.roles].
final sessionRolesProvider = Provider<List<String>>((ref) {
  final status = ref.watch(authStatusProvider);
  final session = ref.read(authSessionProvider);
  return status == AuthStatus.authenticated ? session.roles : const [];
});

/// The shell the current session resolves to. See [resolveShellRole].
final shellRoleProvider = Provider<ShellRole>((ref) {
  return resolveShellRole(ref.watch(sessionRolesProvider));
});
