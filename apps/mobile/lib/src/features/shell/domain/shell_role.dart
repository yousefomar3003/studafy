import 'app_role.dart';

/// Which app shell a session lands in. Distinct from [AppRole]: several platform roles can
/// collapse onto the same shell (an instructor and a teaching assistant both get
/// [ShellRole.teacher]), and roles with no mobile-specific experience yet fall back to
/// [ShellRole.viewer].
enum ShellRole { student, teacher, parent, viewer }

/// Roles mobile treats as read-only: their real workflows live on the web admin console, so on
/// mobile they only ever get [ShellRole.viewer] — a view-only banner and no mutation
/// affordances — regardless of any other role also present on the session.
const _adminTypeRoles = {
  AppRole.superAdmin,
  AppRole.orgAdmin,
  AppRole.finance,
  AppRole.supportAgent,
};

/// Resolves which shell a session lands in from its access token's `roles` claim.
///
/// A session can carry more than one role; this picks a single shell with a fixed priority:
/// an admin-type role always wins (mobile is never their primary surface, so it stays
/// view-only even alongside a teaching/student/parent role), then teaching roles, then
/// student, then parent. `GUEST`, an unrecognized claim, or no roles at all fall back to
/// [ShellRole.viewer] — the safest, no-mutation posture.
ShellRole resolveShellRole(List<String> roleClaims) {
  final roles = roleClaims.map(AppRole.fromClaim).whereType<AppRole>().toSet();

  if (roles.any(_adminTypeRoles.contains)) return ShellRole.viewer;
  if (roles.contains(AppRole.instructor) || roles.contains(AppRole.teachingAssistant)) {
    return ShellRole.teacher;
  }
  if (roles.contains(AppRole.student)) return ShellRole.student;
  if (roles.contains(AppRole.parent)) return ShellRole.parent;

  return ShellRole.viewer;
}

extension ShellRoleMutation on ShellRole {
  /// Whether this shell shows any mutation affordance (compose/add/edit actions). `false` only
  /// for [ShellRole.viewer] — the read-only posture required for admin-type roles on mobile.
  bool get canMutate => this != ShellRole.viewer;
}
