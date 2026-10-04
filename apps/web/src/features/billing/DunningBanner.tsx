import { Button } from "@studafy/ui";

import { useLocale, useTranslation } from "../../lib/i18n";

import { formatIsoDate } from "./format";

import type { BillingOverview } from "./queries";

export interface DunningBannerProps {
  subscription: BillingOverview["subscription"];
  onManagePayment: () => void;
  managingPayment: boolean;
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
  const { t } = useTranslation();
  const { locale } = useLocale();
  const { status, currentPeriodEnd } = subscription;

  if (status !== "past_due" && status !== "grace_period") {
    return null;
  }

  const tone = status === "grace_period" ? "danger" : "warning";
  const title =
    status === "grace_period"
      ? t("site.billing.dunning.graceTitle")
      : t("site.billing.dunning.pastDueTitle");
  const body =
    status === "grace_period"
      ? t("site.billing.dunning.graceBody", { date: formatIsoDate(currentPeriodEnd, locale) })
      : t("site.billing.dunning.pastDueBody");

  return (
    <div className="billing-banner" data-tone={tone} role="status">
      <div>
        <p className="billing-banner__title">{title}</p>
        <p className="billing-banner__body">{body}</p>
      </div>
      <Button type="button" variant="primary" loading={managingPayment} onClick={onManagePayment}>
        {t("site.billing.dunning.updatePayment")}
      </Button>
    </div>
  );
}
