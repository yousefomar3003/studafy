import { Link } from "react-router-dom";

import { useSeo } from "../../components/Seo";
import { Trans, useFormatters, useTranslation } from "../../lib/i18n";

import { ClosingBand } from "./ClosingBand";
import { FEATURE_DEMOS } from "./demos/FeatureDemos";
import { reveal } from "./reveal";

interface FeatureGroup {
  /** Key under `site.marketing.features.groups`: title, body, and `items.<id>` live there. */
  id: string;
  items: string[];
}

const FEATURE_GROUPS: FeatureGroup[] = [
  { id: "academics", items: ["years", "subjects", "enrollment", "timetable"] },
  { id: "attendance", items: ["register", "corrections", "office", "reports"] },
  { id: "homework", items: ["assignments", "submissions", "marking"] },
  { id: "exams", items: ["structure", "entry", "approval", "release"] },
  { id: "finance", items: ["fees", "invoices", "payments", "family", "vat", "reports"] },
  { id: "families", items: ["children", "siblings", "notifications", "language"] },
  { id: "announcements", items: ["audience", "schedule"] },
  { id: "discipline", items: ["incidents", "evaluations"] },
  { id: "records", items: ["fields", "sensitive", "missing", "lists"] },
  { id: "imports", items: ["students", "staff", "history"] },
  { id: "oversight", items: ["approvals", "audit", "requests"] },
];

/** Marketing features page (`/features`), code-split like the rest of the non-marketing-home routes. */
export default function FeaturesPage() {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();

  useSeo({
    title: t("site.marketing.features.seoTitle"),
    description: t("site.marketing.features.seoDescription"),
    path: "/features",
  });

  return (
    <>
      <section className="mk-hero">
        <div className="marketing-container">
          <h1 className="mk-hero__title">{t("site.marketing.features.heroTitle")}</h1>
          <p className="mk-hero__body">{t("site.marketing.features.heroBody")}</p>
        </div>
      </section>

      <section className="mk-section mk-section--flush">
        <div className="marketing-container">
          {/* A ruled index rather than a card grid: modules of uneven length read as a spec sheet,
              one row each, and each row carries a small working example of what it describes. */}
          <ol className="features-index">
            {FEATURE_GROUPS.map((group, index) => {
              const Demo = FEATURE_DEMOS[group.id];
              return (
                <li key={group.id} className="features-index__row" {...reveal()}>
                  <span className="features-index__number" aria-hidden="true">
                    {formatNumber(index + 1, { minimumIntegerDigits: 2 })}
                  </span>
                  <div className="features-index__intro">
                    <h2 className="features-index__title">
                      {t(`site.marketing.features.groups.${group.id}.title`)}
                    </h2>
                    <p className="features-index__body">
                      {t(`site.marketing.features.groups.${group.id}.body`)}
                    </p>
                    <ul className="features-index__items">
                      {group.items.map((item) => (
                        <li key={item}>
                          {t(`site.marketing.features.groups.${group.id}.items.${item}`)}
                        </li>
                      ))}
                    </ul>
                  </div>
                  {Demo ? (
                    <div
                      className="features-index__demo"
                      role="group"
                      aria-label={`${t("site.marketing.features.demos.tryIt")}: ${t(
                        `site.marketing.features.groups.${group.id}.title`,
                      )}`}
                    >
                      <p className="mk-pane__role">{t("site.marketing.features.demos.tryIt")}</p>
                      <Demo />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </div>
      </section>

      <section className="mk-section mk-section--alt" aria-labelledby="mk-ai">
        <div className="marketing-container mk-split" {...reveal()}>
          <div>
            <p className="mk-label">{t("site.marketing.features.aiLabel")}</p>
            <h2 id="mk-ai" className="mk-section__title">
              {t("site.marketing.features.aiTitle")}
            </h2>
          </div>
          <p className="mk-section__lede">
            <Trans
              i18nKey="site.marketing.features.aiBody"
              t={t}
              components={[<Link key="pricing" className="mk-link" to="/pricing" />]}
            />
          </p>
        </div>
      </section>

      <ClosingBand titleKey="site.marketing.features.ctaTitle" />
    </>
  );
}
