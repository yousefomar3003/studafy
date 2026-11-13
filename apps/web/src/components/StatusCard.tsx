import { useTranslation } from "../lib/i18n";

export interface StatusCardAction {
  readonly label: string;
  readonly href: string;
}

export interface StatusCardProps {
  readonly heading: string;
  readonly message: string;
  readonly action?: StatusCardAction;
  /** Correlation id for support, when the outcome came from a server error. */
  readonly requestId?: string | null;
}

/**
 * The shared "this flow stopped here" card. Every way a flow can end without landing the user where
 * they expected renders through this one component: the invitation verification failures and the
 * post-activation mismatch in the invite routes, and the OAuth sign-in failures on `/auth/error`.
 * One layout — a heading, plain-language guidance, and at most one next step — keeps every stop-here
 * state visually and semantically consistent instead of several near-duplicate hand-rolled markups.
 *
 * `role="alert"` announces the outcome to assistive tech as soon as it renders, matching this app's
 * existing convention for "something needs the user's attention" (`RouteError`, `ErrorBoundary`).
 */
export function StatusCard({ heading, message, action, requestId }: StatusCardProps) {
  const { t } = useTranslation();

  return (
    <div role="alert" className="status-card">
      <h1>{heading}</h1>
      <p>{message}</p>
      {action && (
        <p>
          <a href={action.href} className="status-card__action">
            {action.label}
          </a>
        </p>
      )}
      {requestId && (
        <p className="status-card__reference">{t("site.statusCard.reference", { requestId })}</p>
      )}
    </div>
  );
}
