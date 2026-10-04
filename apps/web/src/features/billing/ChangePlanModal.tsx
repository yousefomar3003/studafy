import { ApiError } from "@studafy/api-client";
import { Button, Modal, Radio, RadioGroup, useToast } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { useLocale, useTranslation } from "../../lib/i18n";

import { formatMinorAmount } from "./format";
import { useStartSchoolCheckout } from "./mutations";
import { BILLING_PLANS_QUERY_KEY, fetchBillingPlans } from "./queries";

import type { SubscriptionPlan } from "./queries";
import type { Locale } from "../../lib/i18n";
import type { TFunction } from "i18next";
import type { FormEvent } from "react";

export interface ChangePlanModalProps {
  open: boolean;
  currentPlanId: string | undefined;
  onClose: () => void;
}

function apiErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  return error.detail ?? error.title;
}

/** Prefers a monthly, USD price for the label — same preference order `PricingPage.tsx` uses. */
function priceFor(plan: SubscriptionPlan): SubscriptionPlan["prices"][number] | undefined {
  const monthly = plan.prices.filter((price) => price.billingInterval === "monthly");
  return monthly.find((price) => price.currencyCode === "USD") ?? monthly[0] ?? plan.prices[0];
}

function planLabel(
  plan: SubscriptionPlan,
  isCurrent: boolean,
  t: TFunction,
  locale: Locale,
): string {
  const price = priceFor(plan);
  let label = plan.displayName;
  if (price) {
    const amount = formatMinorAmount(price.amountMinor, price.currencyCode, locale);
    const priceText =
      price.billingInterval === "monthly"
        ? t("site.billing.changePlanModal.pricePerMonth", { amount })
        : t("site.billing.changePlanModal.pricePerYear", { amount });
    label = t("site.billing.changePlanModal.optionWithPrice", { plan: label, price: priceText });
  }
  return isCurrent ? t("site.billing.changePlanModal.currentPlan", { label }) : label;
}

/**
 * Checkout entry: lets the admin pick a plan and starts a seat-based Stripe Checkout session for it,
 * then redirects to the provider's hosted page — Studafy never collects card details itself. Reads
 * the same public plan catalog the marketing pricing page does (`GET /api/subscriptions/plans`).
 */
export function ChangePlanModal({ open, currentPlanId, onClose }: ChangePlanModalProps) {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const { show } = useToast();
  const [planId, setPlanId] = useState("");
  const plansQuery = useQuery({
    queryKey: BILLING_PLANS_QUERY_KEY,
    queryFn: fetchBillingPlans,
    enabled: open,
  });
  const checkout = useStartSchoolCheckout();

  const plans = plansQuery.data ?? [];

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!planId) return;
    checkout.mutate(planId, {
      onSuccess: (result) => {
        window.location.assign(result.url);
      },
      onError: (error) =>
        show({
          variant: "error",
          title: t("site.billing.changePlanModal.checkoutError"),
          description: apiErrorMessage(error, t("site.common.tryAgain")),
        }),
    });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("site.billing.changePlanModal.title")}
      description={t("site.billing.changePlanModal.description")}
    >
      <form onSubmit={handleSubmit} noValidate>
        <Modal.Body>
          {plansQuery.isPending ? (
            <p role="status">{t("site.billing.changePlanModal.loading")}</p>
          ) : plansQuery.isError ? (
            <p role="alert">{t("site.billing.changePlanModal.loadError")}</p>
          ) : plans.length === 0 ? (
            <p>{t("site.billing.changePlanModal.empty")}</p>
          ) : (
            // No `required` here: `RadioGroup` renders it as `aria-required` on the `<fieldset>`,
            // which axe flags (`aria-allowed-attr`) since ARIA doesn't permit `aria-required` on a
            // group role — same as `RecordPaymentPage`'s payment-method group. The submit button's
            // own `disabled={!planId}` already enforces the requirement.
            <RadioGroup
              label={t("site.billing.changePlanModal.groupLabel")}
              name="plan"
              value={planId}
              onChange={setPlanId}
            >
              {plans.map((plan) => (
                <Radio
                  key={plan.id}
                  value={plan.id}
                  disabled={plan.id === currentPlanId}
                  label={planLabel(plan, plan.id === currentPlanId, t, locale)}
                />
              ))}
            </RadioGroup>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button type="button" variant="tertiary" onClick={onClose}>
            {t("site.common.cancel")}
          </Button>
          <Button type="submit" variant="primary" loading={checkout.isPending} disabled={!planId}>
            {t("site.billing.changePlanModal.continue")}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
