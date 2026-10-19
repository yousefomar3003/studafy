import { Card, Chip } from "@studafy/ui";

import { LinkButton } from "../../components/LinkButton";
import { useSeo } from "../../components/Seo";
import { useTranslation } from "../../lib/i18n";

/** Keys under `site.marketing.pricing.included`, translated at render time. */
const INCLUDED_FOR_EVERY_SCHOOL = ["academics", "finance", "family", "approvals"] as const;

/**
 * Pricing page (`/pricing`). Studafy is free for schools (migration 000126 puts every school on the
 * `free` plan), so there is no plan catalog to fetch: one free offer for schools, and the per-student
 * AI add-on, which students buy for themselves.
 */
export default function PricingPage() {
  const { t } = useTranslation();

  useSeo({
    title: t("site.marketing.pricing.seoTitle"),
    description: t("site.marketing.pricing.seoDescription"),
    path: "/pricing",
  });

  return (
    <>
      <section className="marketing-hero">
        <div className="marketing-container">
          <h1 className="marketing-hero__title">{t("site.marketing.pricing.heroTitle")}</h1>
          <p className="marketing-hero__subtitle">{t("site.marketing.pricing.heroSubtitle")}</p>
        </div>
      </section>

      <section className="marketing-section">
        <div className="marketing-container">
          <div className="marketing-grid">
            <Card>
              <Card.Body>
                <h2 className="marketing-pricing-card__name">
                  {t("site.marketing.pricing.freePlanName")}
                </h2>

                <div className="marketing-pricing-card__price">
                  <span className="marketing-pricing-card__amount">
                    {t("site.marketing.pricing.freePlanPrice")}
                  </span>
                </div>

                <ul className="marketing-pricing-card__list">
                  {INCLUDED_FOR_EVERY_SCHOOL.map((item) => (
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
                  {t("site.marketing.pricing.contactUs")}
                </LinkButton>
              </Card.Body>
            </Card>
          </div>
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
