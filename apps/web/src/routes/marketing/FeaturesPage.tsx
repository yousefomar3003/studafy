import { Card, Chip } from "@studafy/ui";
import { Link } from "react-router-dom";

import { LinkButton } from "../../components/LinkButton";
import { useSeo } from "../../components/Seo";
import { Trans, useTranslation } from "../../lib/i18n";

interface FeatureGroup {
  /** Key under `site.marketing.features.groups` — title, body, and `items.<id>` live there. */
  id: string;
  items: string[];
}

const FEATURE_GROUPS: FeatureGroup[] = [
  { id: "academics", items: ["years", "subjects", "enrollment", "timetabling"] },
  { id: "attendance", items: ["sessions", "corrections", "reporting"] },
  { id: "grades", items: ["assignments", "exams", "entry", "reporting"] },
  { id: "discipline", items: ["cases", "evaluations"] },
  { id: "finance", items: ["fees", "scholarships", "payments", "reconciliation"] },
  { id: "family", items: ["perChild", "siblings", "preferences"] },
  { id: "approvals", items: ["queue", "audit"] },
];

/** Marketing features page (`/features`), code-split like the rest of the non-marketing-home routes. */
export default function FeaturesPage() {
  const { t } = useTranslation();

  useSeo({
    title: t("site.marketing.features.seoTitle"),
    description: t("site.marketing.features.seoDescription"),
    path: "/features",
  });

  return (
    <>
      <section className="marketing-hero">
        <div className="marketing-container">
          <h1 className="marketing-hero__title">{t("site.marketing.features.heroTitle")}</h1>
          <p className="marketing-hero__subtitle">{t("site.marketing.features.heroSubtitle")}</p>
        </div>
      </section>

      <section className="marketing-section">
        <div className="marketing-container">
          <div className="marketing-grid">
            {FEATURE_GROUPS.map((group) => (
              <Card key={group.id}>
                <Card.Body>
                  <h2 className="marketing-feature-card__title">
                    {t(`site.marketing.features.groups.${group.id}.title`)}
                  </h2>
                  <p className="marketing-feature-card__body">
                    {t(`site.marketing.features.groups.${group.id}.body`)}
                  </p>
                  <ul className="marketing-feature-card__list">
                    {group.items.map((item) => (
                      <li key={item}>
                        {t(`site.marketing.features.groups.${group.id}.items.${item}`)}
                      </li>
                    ))}
                  </ul>
                </Card.Body>
              </Card>
            ))}
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
                  {t("site.marketing.features.aiTitle")}
                </h2>
                <p className="marketing-feature-card__body">
                  <Trans
                    i18nKey="site.marketing.features.aiBody"
                    t={t}
                    components={[<Link key="pricing" to="/pricing" />]}
                  />
                </p>
              </Card.Body>
            </Card>
          </div>
        </div>
      </section>

      <section className="marketing-section">
        <div className="marketing-container marketing-cta-band">
          <h2 className="marketing-cta-band__title">{t("site.marketing.features.ctaTitle")}</h2>
          <div className="marketing-cta-band__actions">
            <LinkButton href="/about#contact" variant="primary">
              {t("site.marketing.cta.talkToUs")}
            </LinkButton>
            <LinkButton href="/pricing" variant="tertiary">
              {t("site.marketing.cta.seePricing")}
            </LinkButton>
          </div>
        </div>
      </section>
    </>
  );
}
