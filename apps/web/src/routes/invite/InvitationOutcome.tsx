export interface InvitationOutcomeAction {
  readonly label: string;
  readonly href: string;
}

export interface InvitationOutcomeProps {
  readonly heading: string;
  readonly message: string;
  readonly action?: InvitationOutcomeAction;
  /** Correlation id for support, when the outcome came from a server error. */
  readonly requestId?: string | null;
}

/**
 * The shared "invitation flow stopped here" card. Every way the flow can end without landing the
 * user in their portal renders through this one component: the four terminal verification failures
 * (expired, revoked, consumed, school suspended) and the malformed/unknown-token case in
 * `InvitePage`, plus the post-activation email-mismatch outcome in `InviteCompletePage`. One
 * layout — a heading, plain-language guidance, and at most one next step — keeps every stop-here
 * state visually and semantically consistent instead of five near-duplicate hand-rolled markups.
 *
 * `role="alert"` announces the outcome to assistive tech as soon as it renders, matching this app's
 * existing convention for "something needs the user's attention" (`RouteError`, `ErrorBoundary`).
 */
export function InvitationOutcome({ heading, message, action, requestId }: InvitationOutcomeProps) {
  return (
    <div role="alert">
      <h1>{heading}</h1>
      <p>{message}</p>
      {action && (
        <p>
          <a href={action.href}>{action.label}</a>
        </p>
      )}
      {requestId && <p>Reference: {requestId}</p>}
    </div>
  );
}
