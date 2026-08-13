import { ApiError } from "@studafy/api-client";
import { Card, Chip } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { LinkButton } from "../../components/LinkButton";
import { useSeo } from "../../components/Seo";
import { api } from "../../lib/api";

import type { operations } from "@studafy/api-client";

// The route has no named OpenAPI component schema (plan-routes.ts inlines the response shape), so
// the element type is pulled from the operation's response rather than `components["schemas"]`.
type Plan =
  operations["listSubscriptionPlans"]["responses"][200]["content"]["application/json"][number];
type BillingInterval = "monthly" | "yearly";

const INCLUDED_IN_EVERY_PLAN = [
  "Academics, attendance, grades, and discipline",
  "Finance and billing",
  "Family portal and notifications",
  "Approvals and audit trail",
];

/** Picks the price for the selected interval, preferring USD when a plan has more than one currency. */
function priceFor(plan: Plan, interval: BillingInterval): Plan["prices"][number] | undefined {
  const matches = plan.prices.filter((price) => price.billingInterval === interval);
  return matches.find((price) => price.currencyCode === "USD") ?? matches[0];
}

function formatAmount(amountMinor: number, currencyCode: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currencyCode,
      minimumFractionDigits: amountMinor % 100 === 0 ? 0 : 2,
    }).format(amountMinor / 100);
  } catch {
    // An unrecognized ISO currency code would throw inside Intl.NumberFormat; fall back to a plain
    // number rather than letting the whole pricing page crash on bad reference data.
    return `${(amountMinor / 100).toFixed(2)} ${currencyCode}`;
  }
}

/**
 * Pricing page (`/pricing`). Plan names, descriptions, and prices come from
 * `GET /api/subscriptions/plans` — a public endpoint (this marketing-pages change made it so; it was
 * previously gated behind the JWT boundary even though the query itself is not school-scoped). What
 * each plan includes is *not* tiered in the schema — `app.plans` has no feature/limit columns, so
 * every plan gets the same module list, and per-plan specifics (e.g. a student ceiling) live only in
 * that plan's own `description` from the API.
 */
export default function PricingPage() {
  useSeo({
    title: "Pricing",
    description: "School subscription tiers and the optional AI add-on, with live pricing.",
    path: "/pricing",
  });

  const [interval, setInterval] = useState<BillingInterval>("monthly");

  const { data, isPending, isError, error } = useQuery({
    queryKey: ["marketing", "plans"],
    queryFn: async () => {
      const { data } = await api.GET("/api/subscriptions/plans");
      return data;
    },
  });

  // A bare top-level array response (unlike every other route, which wraps results in an object)
  // loses its `Array` prototype through the generated response type — the same pre-existing
  // `@studafy/api-client` typing gap ApprovalsPage.tsx works around, not a shape mismatch. The
  // annotation restores it without widening to `any`.
  const plans = (data ?? []) as readonly Plan[];

  return (
    <>
      <section className="marketing-hero">
        <div className="marketing-container">
          <h1 className="marketing-hero__title">Simple, per-school pricing</h1>
          <p className="marketing-hero__subtitle">
            One subscription per school. Every plan includes the same modules — the difference is
            scale, described on each plan below.
          </p>

          <div className="marketing-pricing-toggle" role="group" aria-label="Billing interval">
            <button
              type="button"
              className="marketing-pricing-toggle__option"
              aria-pressed={interval === "monthly"}
              onClick={() => setInterval("monthly")}
            >
              Monthly
            </button>
            <button
              type="button"
              className="marketing-pricing-toggle__option"
              aria-pressed={interval === "yearly"}
              onClick={() => setInterval("yearly")}
            >
              Yearly
            </button>
          </div>
        </div>
      </section>

      <section className="marketing-section">
        <div className="marketing-container">
          {isPending && (
            <p className="marketing-pricing-state" role="status" aria-live="polite">
              Loading plans…
            </p>
          )}

          {isError && (
            <p className="marketing-pricing-state" role="alert">
              We couldn&rsquo;t load current pricing
              {error instanceof ApiError && error.request_id
                ? ` (reference ${error.request_id})`
                : ""}
              . Please <a href="/about#contact">contact us</a> for current rates.
            </p>
          )}

          {!isPending && !isError && plans.length === 0 && (
            <p className="marketing-pricing-state">
              No plans are published yet. <a href="/about#contact">Contact us</a> for pricing.
            </p>
          )}

          {plans.length > 0 && (
            <div className="marketing-grid">
              {plans.map((plan) => {
                const price = priceFor(plan, interval);
                return (
                  <Card key={plan.id}>
                    <Card.Body>
                      <h2 className="marketing-pricing-card__name">{plan.displayName}</h2>
                      {plan.description && (
                        <p className="marketing-pricing-card__description">{plan.description}</p>
                      )}

                      <div className="marketing-pricing-card__price">
                        {price ? (
                          <>
                            <span className="marketing-pricing-card__amount">
                              {formatAmount(price.amountMinor, price.currencyCode)}
                            </span>
                            <span className="marketing-pricing-card__interval">
                              /{interval === "monthly" ? "mo" : "yr"}
                            </span>
                          </>
                        ) : (
                          <span className="marketing-pricing-card__interval">
                            No {interval} price published
                          </span>
                        )}
                      </div>

                      <ul className="marketing-pricing-card__list">
                        {INCLUDED_IN_EVERY_PLAN.map((item) => (
                          <li key={item}>
                            <svg
                              width="16"
                              height="16"
                              viewBox="0 0 16 16"
                              aria-hidden="true"
                              focusable="false"
                            >
                              <path
                                d="M3.5 8.5l3 3 6-7"
                                stroke="currentColor"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                fill="none"
                              />
                            </svg>
                            {item}
                          </li>
                        ))}
                      </ul>

                      <LinkButton href="/about#contact" variant="secondary" fullWidth>
                        Talk to us about {plan.displayName}
                      </LinkButton>
                    </Card.Body>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      </section>

      <section className="marketing-section marketing-section--muted">
        <div className="marketing-container">
          <div className="marketing-ai-callout">
            <Card>
              <Card.Body>
                <Chip>Add-on</Chip>
                <h2 className="marketing-feature-card__title">AI add-on</h2>
                <p className="marketing-feature-card__body">
                  Ask AI and study-material summaries are billed separately from the school plan: an
                  active school subscription is required first, then the add-on is purchased per
                  student and metered against a monthly usage budget.
                </p>
                <p className="marketing-pricing-note">
                  Ask us for current add-on pricing when you talk to us about a school plan.
                </p>
              </Card.Body>
            </Card>
          </div>
        </div>
      </section>
    </>
  );
}
