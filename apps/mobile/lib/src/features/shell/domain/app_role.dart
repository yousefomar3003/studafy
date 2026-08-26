/// The fixed platform roles a session can carry.
///
/// Mirrors `ROLES` in `packages/constants/src/roles.ts` — see
/// `docs/adr/0002-fixed-roles-authorization.md` for why roles are a static, compile-time
/// enumeration rather than a database-driven table. Kept in lockstep by convention, not by
/// import: the mobile app doesn't share a package with the API/web apps for this.
enum AppRole {
  superAdmin('SUPER_ADMIN'),
  orgAdmin('ORG_ADMIN'),
  finance('FINANCE'),
  instructor('INSTRUCTOR'),
  teachingAssistant('TEACHING_ASSISTANT'),
  student('STUDENT'),
  parent('PARENT'),
  guest('GUEST'),
  supportAgent('SUPPORT_AGENT');

  const AppRole(this.claim);

  /// The exact string this role is encoded as in the access token's `roles` claim.
  final String claim;

  /// Parses one `roles` claim entry. `null` for a value outside the fixed set — a forward-
  /// compatible no-op, not an error, since new roles roll out server-side first.
  static AppRole? fromClaim(String claim) {
    for (final role in values) {
      if (role.claim == claim) return role;
    }
    return null;
  }
}
