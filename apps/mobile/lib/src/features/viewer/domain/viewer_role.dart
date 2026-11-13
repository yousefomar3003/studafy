import '../../shell/domain/app_role.dart';

/// Which read-only summary a viewer-shell session sees.
///
/// Distinct from [ShellRole]: that only decides whether a session lands in the view-only shell
/// at all. This decides *which* summary it sees once there, since several platform roles share
/// that one shell.
enum ViewerRole { admin, finance, unsupported }

/// Picks [ViewerRole] from a session's raw `roles` claim, with the same fixed-priority shape
/// [resolveShellRole] uses for [ShellRole]: an admin-type role wins first.
///
/// SUPER_ADMIN and ORG_ADMIN share one summary — there is no distinct PRINCIPAL role; the web
/// app's "Principal" dashboard is the same ORG_ADMIN boundary as its "Admin" one (see
/// `apps/web/src/features/principal/PrincipalDashboardPage.tsx`), just a different page. FINANCE
/// gets its own. SUPPORT_AGENT and anything unrecognized have no mobile-relevant summary yet.
ViewerRole resolveViewerRole(List<String> roleClaims) {
  final roles = roleClaims.map(AppRole.fromClaim).whereType<AppRole>().toSet();

  if (roles.contains(AppRole.superAdmin) || roles.contains(AppRole.orgAdmin)) {
    return ViewerRole.admin;
  }
  if (roles.contains(AppRole.finance)) return ViewerRole.finance;

  return ViewerRole.unsupported;
}
