import { ApiError } from "@studafy/api-client";
import { Card, Chip } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { LinkButton } from "../../components/LinkButton";
import { useSeo } from "../../components/Seo";
import { formatMinorAmount } from "../../features/billing/format";
import { api } from "../../lib/api";
import { Trans, useLocale, useTranslation } from "../../lib/i18n";

import type { operations } from "@studafy/api-client";

// The route has no named OpenAPI component schema (plan-routes.ts inlines the response shape), so
// the element type is pulled from the operation's response rather than `components["schemas"]`.
type Plan =
  operations["listSubscriptionPlans"]["responses"][200]["content"]["application/json"][number];
type BillingInterval = "monthly" | "yearly";

/** Keys under `site.marketing.pricing.included`, translated at render time. */
const INCLUDED_IN_EVERY_PLAN = ["academics", "finance", "family", "approvals"] as const;

const CONTACT_LINK = <a key="contact" href="/about#contact" />;

/** Picks the price for the selected interval, preferring USD when a plan has more than one currency. */
function priceFor(plan: Plan, interval: BillingInterval): Plan["prices"][number] | undefined {
  const matches = plan.prices.filter((price) => price.billingInterval === interval);
  return matches.find((price) => price.currencyCode === "USD") ?? matches[0];
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
  const { t } = useTranslation();
  const { locale } = useLocale();

  useSeo({
    title: t("site.marketing.pricing.seoTitle"),
    description: t("site.marketing.pricing.seoDescription"),
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
  // `@studafy/api-client` typing gap ApprovalQueuePage.tsx works around, not a shape mismatch. The
  // annotation restores it without widening to `any`.
  const plans = (data ?? []) as readonly Plan[];

  return (
    <>
      <section className="marketing-hero">
        <div className="marketing-container">
          <h1 className="marketing-hero__title">{t("site.marketing.pricing.heroTitle")}</h1>
          <p className="marketing-hero__subtitle">{t("site.marketing.pricing.heroSubtitle")}</p>

          <div
            className="marketing-pricing-toggle"
            role="group"
            aria-label={t("site.marketing.pricing.intervalGroupLabel")}
          >
            <button
              type="button"
              className="marketing-pricing-toggle__option"
              aria-pressed={interval === "monthly"}
              onClick={() => setInterval("monthly")}
            >
              {t("site.marketing.pricing.monthly")}
            </button>
            <button
              type="button"
              className="marketing-pricing-toggle__option"
              aria-pressed={interval === "yearly"}
              onClick={() => setInterval("yearly")}
            >
              {t("site.marketing.pricing.yearly")}
            </button>
          </div>
        </div>
      </section>

      <section className="marketing-section">
        <div className="marketing-container">
          {isPending && (
            <p className="marketing-pricing-state" role="status" aria-live="polite">
              {t("site.marketing.pricing.loading")}
            </p>
          )}

          {isError && (
            <p className="marketing-pricing-state" role="alert">
              {error instanceof ApiError && error.request_id ? (
                <Trans
                  i18nKey="site.marketing.pricing.loadErrorWithReference"
                  t={t}
                  values={{ requestId: error.request_id }}
                  components={[CONTACT_LINK]}
                />
              ) : (
                <Trans
                  i18nKey="site.marketing.pricing.loadError"
                  t={t}
                  components={[CONTACT_LINK]}
                />
              )}
            </p>
          )}

          {!isPending && !isError && plans.length === 0 && (
            <p className="marketing-pricing-state">
              <Trans i18nKey="site.marketing.pricing.empty" t={t} components={[CONTACT_LINK]} />
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
                              {formatMinorAmount(price.amountMinor, price.currencyCode, locale)}
                            </span>
                            <span className="marketing-pricing-card__interval">
                              {interval === "monthly"
                                ? t("site.marketing.pricing.perMonth")
                                : t("site.marketing.pricing.perYear")}
                            </span>
                          </>
                        ) : (
                          <span className="marketing-pricing-card__interval">
                            {interval === "monthly"
                              ? t("site.marketing.pricing.noMonthlyPrice")
                              : t("site.marketing.pricing.noYearlyPrice")}
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
                            {t(`site.marketing.pricing.included.${item}`)}
                          </li>
                        ))}
                      </ul>

                      <LinkButton href="/about#contact" variant="secondary" fullWidth>
                        {t("site.marketing.pricing.talkAboutPlan", { plan: plan.displayName })}
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
                <Chip>{t("site.marketing.addOnChip")}</Chip>
                <h2 className="marketing-feature-card__title">
                  {t("site.marketing.pricing.addOnTitle")}
                </h2>
                <p className="marketing-feature-card__body">
                  {t("site.marketing.pricing.addOnBody")}
                </p>
                <p className="marketing-pricing-note">{t("site.marketing.pricing.addOnNote")}</p>
              </Card.Body>
            </Card>
          </div>
        </div>
      </section>
    </>
  );
}
