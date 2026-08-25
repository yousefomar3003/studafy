/// Outcome of [AuthNotifier.activateInvitation] (ST-215) — every state the mobile invitation
/// activation flow can land in, so the screen can `switch` on a concrete subtype instead of
/// branching on strings. Mirrors the outcomes `apps/web/src/routes/invite` renders for the browser
/// flow: the same lifecycle codes, the same admin-approval divergence, plus a mobile-only
/// [InvitationActivationCancelled] for the system-browser sign-in sheet being dismissed.
sealed class InvitationActivationResult {
  const InvitationActivationResult();
}

/// The invitation was consumed and the app now holds an authenticated session.
class InvitationActivationActivated extends InvitationActivationResult {
  const InvitationActivationActivated();
}

/// The verified identity's email diverged from the invitation's bound email. Nothing was
/// activated; the invitation is untouched, so the same link still works once resolved.
class InvitationActivationRequiresApproval extends InvitationActivationResult {
  const InvitationActivationRequiresApproval();
}

/// The user dismissed the system browser before completing sign-in. Not a failure — just retry.
class InvitationActivationCancelled extends InvitationActivationResult {
  const InvitationActivationCancelled();
}

/// The invitation's lifecycle state changed between verification and activation (expired, revoked,
/// consumed, or the school was suspended, or the token was malformed). [code] is the same stable
/// `ApiException.code` the verify endpoint uses, so the screen can render the identical failure
/// copy either way.
class InvitationActivationLifecycleFailed extends InvitationActivationResult {
  const InvitationActivationLifecycleFailed(this.code);
  final String? code;
}

/// Anything else — network failure, unreachable provider, unparseable response.
class InvitationActivationFailed extends InvitationActivationResult {
  const InvitationActivationFailed();
}
