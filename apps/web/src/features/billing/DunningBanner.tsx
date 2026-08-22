import { Button } from "@studafy/ui";

import type { BillingOverview } from "./queries";

export interface DunningBannerProps {
  subscription: BillingOverview["subscription"];
  onManagePayment: () => void;
  managingPayment: boolean;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString();
}

/**
 * Payment-failure banner states (`past_due`, `grace_period` — see `SUBSCRIPTION_STATUSES`'s state
 * machine doc comment in `packages/constants`). Renders nothing for every other status; the "your
 * subscription has ended" case is a different concern and handled inline by `BillingOverviewPage`.
 */
export function DunningBanner({
  subscription,
  onManagePayment,
  managingPayment,
}: DunningBannerProps) {
  const { status, currentPeriodEnd } = subscription;

  if (status !== "past_due" && status !== "grace_period") {
    return null;
  }

  const tone = status === "grace_period" ? "danger" : "warning";
  const title =
    status === "grace_period"
      ? "Your subscription is in a grace period"
      : "Your last payment failed";
  const body =
    status === "grace_period"
      ? `Update your payment method before ${formatDate(currentPeriodEnd)} to keep access — the subscription closes automatically once the grace window ends.`
      : "Update your payment method to keep the subscription active before the grace period begins.";

  return (
    <div className="billing-banner" data-tone={tone} role="status">
      <div>
        <p className="billing-banner__title">{title}</p>
        <p className="billing-banner__body">{body}</p>
      </div>
      <Button type="button" variant="primary" loading={managingPayment} onClick={onManagePayment}>
        Update payment method
      </Button>
    </div>
  );
}
