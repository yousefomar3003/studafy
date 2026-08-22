import { ApiError } from "@studafy/api-client";
import { Button, Modal, Radio, RadioGroup, useToast } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { useStartSchoolCheckout } from "./mutations";
import { BILLING_PLANS_QUERY_KEY, fetchBillingPlans } from "./queries";

import type { SubscriptionPlan } from "./queries";
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

function formatAmount(amountMinor: number, currencyCode: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currencyCode,
      minimumFractionDigits: amountMinor % 100 === 0 ? 0 : 2,
    }).format(amountMinor / 100);
  } catch {
    // An unrecognized ISO currency code would throw inside Intl.NumberFormat — same fallback
    // `PricingPage.tsx` uses rather than letting the picker crash on bad reference data.
    return `${(amountMinor / 100).toFixed(2)} ${currencyCode}`;
  }
}

function planLabel(plan: SubscriptionPlan, isCurrent: boolean): string {
  const price = priceFor(plan);
  const priceText = price
    ? ` — ${formatAmount(price.amountMinor, price.currencyCode)}/${price.billingInterval === "monthly" ? "mo" : "yr"}`
    : "";
  return `${plan.displayName}${priceText}${isCurrent ? " (current plan)" : ""}`;
}

/**
 * Checkout entry: lets the admin pick a plan and starts a seat-based Stripe Checkout session for it,
 * then redirects to the provider's hosted page — Studafy never collects card details itself. Reads
 * the same public plan catalog the marketing pricing page does (`GET /api/subscriptions/plans`).
 */
export function ChangePlanModal({ open, currentPlanId, onClose }: ChangePlanModalProps) {
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
          title: "Couldn't start checkout",
          description: apiErrorMessage(error, "Please try again."),
        }),
    });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Change plan"
      description="Starts a checkout session for the new plan's seat-based price. The current plan stays active until checkout completes."
    >
      <form onSubmit={handleSubmit} noValidate>
        <Modal.Body>
          {plansQuery.isPending ? (
            <p role="status">Loading plans…</p>
          ) : plansQuery.isError ? (
            <p role="alert">Unable to load plans.</p>
          ) : plans.length === 0 ? (
            <p>No plans are published yet.</p>
          ) : (
            // No `required` here: `RadioGroup` renders it as `aria-required` on the `<fieldset>`,
            // which axe flags (`aria-allowed-attr`) since ARIA doesn't permit `aria-required` on a
            // group role — same as `RecordPaymentPage`'s payment-method group. The submit button's
            // own `disabled={!planId}` already enforces the requirement.
            <RadioGroup label="Plan" name="plan" value={planId} onChange={setPlanId}>
              {plans.map((plan) => (
                <Radio
                  key={plan.id}
                  value={plan.id}
                  disabled={plan.id === currentPlanId}
                  label={planLabel(plan, plan.id === currentPlanId)}
                />
              ))}
            </RadioGroup>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button type="button" variant="tertiary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={checkout.isPending} disabled={!planId}>
            Continue to checkout
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
