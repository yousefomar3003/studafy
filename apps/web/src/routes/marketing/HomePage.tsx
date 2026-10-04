import { Card } from "@studafy/ui";

import { LinkButton } from "../../components/LinkButton";
import { useSeo } from "../../components/Seo";
import { useTranslation } from "../../lib/i18n";

// Translation keys only — the copy lives in `locales/{en,ar}/site.json` under `site.marketing.home`.
const VALUE_PROPS = ["academics", "grades", "finance", "family"] as const;
const STEPS = ["onboard", "staff", "families"] as const;

/** Marketing landing page (`/`). Eagerly loaded so the initial route paints without a chunk fetch. */
export default function HomePage() {
  const { t } = useTranslation();

  useSeo({
    title: t("site.marketing.home.seoTitle"),
    description: t("site.marketing.home.seoDescription"),
    path: "/",
  });

  return (
    <>
      <section className="marketing-hero">
        <div className="marketing-container">
          <h1 className="marketing-hero__title">{t("site.marketing.home.heroTitle")}</h1>
          <p className="marketing-hero__subtitle">{t("site.marketing.home.heroSubtitle")}</p>
          <div className="marketing-hero__actions">
            <LinkButton href="/about#contact" variant="primary">
              {t("site.marketing.cta.talkToUs")}
            </LinkButton>
            <LinkButton href="/pricing" variant="secondary">
              {t("site.marketing.cta.seePricing")}
            </LinkButton>
          </div>
        </div>
      </section>

      <section className="marketing-section">
        <div className="marketing-container">
          <div className="marketing-section__heading">
            <span className="marketing-section__eyebrow">
              {t("site.marketing.home.includedEyebrow")}
            </span>
            <h2 className="marketing-section__title">{t("site.marketing.home.includedTitle")}</h2>
            <p className="marketing-section__lede">{t("site.marketing.home.includedLede")}</p>
          </div>

          <div className="marketing-grid">
            {VALUE_PROPS.map((id) => (
              <Card key={id}>
                <Card.Body>
                  <h3 className="marketing-feature-card__title">
                    {t(`site.marketing.home.valueProps.${id}.title`)}
                  </h3>
                  <p className="marketing-feature-card__body">
                    {t(`site.marketing.home.valueProps.${id}.body`)}
                  </p>
                </Card.Body>
              </Card>
            ))}
          </div>
        </div>
      </section>

      <section className="marketing-section marketing-section--muted">
        <div className="marketing-container">
          <div className="marketing-section__heading">
            <span className="marketing-section__eyebrow">
              {t("site.marketing.home.howEyebrow")}
            </span>
            <h2 className="marketing-section__title">{t("site.marketing.home.howTitle")}</h2>
          </div>

          <div className="marketing-steps">
            {STEPS.map((id) => (
              <div className="marketing-step" key={id}>
                <h3 className="marketing-step__title">
                  {t(`site.marketing.home.steps.${id}.title`)}
                </h3>
                <p className="marketing-step__body">{t(`site.marketing.home.steps.${id}.body`)}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="marketing-section">
        <div className="marketing-container marketing-cta-band">
          <h2 className="marketing-cta-band__title">{t("site.marketing.home.ctaTitle")}</h2>
          <p className="marketing-cta-band__body">{t("site.marketing.home.ctaBody")}</p>
          <div className="marketing-cta-band__actions">
            <LinkButton href="/about#contact" variant="primary">
              {t("site.marketing.cta.talkToUs")}
            </LinkButton>
            <LinkButton href="/features" variant="tertiary">
              {t("site.marketing.cta.exploreFeatures")}
            </LinkButton>
          </div>
        </div>
      </section>
    </>
  );
}
