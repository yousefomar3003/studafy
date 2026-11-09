import { lazy, Suspense } from "react";
import { Link } from "react-router-dom";

import { LinkButton } from "../../components/LinkButton";
import { useSeo } from "../../components/Seo";
import { loadCatalogAreas, useFormatters, useTranslation } from "../../lib/i18n";

import { ClosingBand } from "./ClosingBand";
import { reveal } from "./reveal";
import { SchoolDay } from "./SchoolDay";

import type { CatalogArea } from "../../lib/i18n";
import type { ReactNode } from "react";

// The live demos sit below the hero, so they load in their own chunk (with their own CSS and their
// copy's catalog area) instead of riding in the bundle every page downloads, sign-in included. Each placeholder reserves roughly
// the demo's height, so nothing below moves when it arrives.
const MARKETING_CATALOGS: readonly CatalogArea[] = ["marketingPages"];
const RegisterDemo = lazy(() =>
  Promise.all([import("./demos/RegisterDemo"), loadCatalogAreas(MARKETING_CATALOGS)]).then(
    ([module]) => ({
      default: module.RegisterDemo,
    }),
  ),
);
const RoleTour = lazy(() =>
  Promise.all([import("./demos/RoleTour"), loadCatalogAreas(MARKETING_CATALOGS)]).then(
    ([module]) => ({
      default: module.RoleTour,
    }),
  ),
);
const LanguageFlip = lazy(() =>
  Promise.all([import("./demos/LanguageFlip"), loadCatalogAreas(MARKETING_CATALOGS)]).then(
    ([module]) => ({
      default: module.LanguageFlip,
    }),
  ),
);
const SensitiveDemo = lazy(() =>
  Promise.all([import("./demos/SensitiveDemo"), loadCatalogAreas(MARKETING_CATALOGS)]).then(
    ([module]) => ({
      default: module.SensitiveDemo,
    }),
  ),
);

function DemoSlot({ height, children }: { height: number; children: ReactNode }) {
  return (
    <Suspense fallback={<div className="mk-demo-slot" style={{ minBlockSize: height }} />}>
      {children}
    </Suspense>
  );
}

// Translation keys only: the copy lives in `locales/{en,ar}/site.json` under `site.marketing.home`.

const MODULES = [
  "academics",
  "attendance",
  "homework",
  "exams",
  "finance",
  "families",
  "announcements",
  "discipline",
  "records",
  "imports",
] as const;

const PRIVACY = ["separate", "sensitive", "history", "requests"] as const;

/**
 * The same interface words in both languages. Deliberately not translated: the point of the table is
 * to show both scripts side by side, whichever language the page is read in.
 */
const LANGUAGE_PAIRS = [
  ["Attendance", "الحضور"],
  ["Homework due Thursday", "واجب يُسلَّم يوم الخميس"],
  ["Term marks released", "تمت إتاحة درجات الفصل"],
  ["Fee instalment paid", "تم دفع القسط"],
  ["Absent today", "غائب اليوم"],
] as const;

/** Marketing landing page (`/`). Eagerly loaded so the initial route paints without a chunk fetch. */
export default function HomePage() {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const number = (index: number) => formatNumber(index + 1, { minimumIntegerDigits: 2 });

  useSeo({
    title: t("site.marketing.home.seoTitle"),
    description: t("site.marketing.home.seoDescription"),
    path: "/",
  });

  return (
    <>
      <section className="mk-hero mk-hero--split">
        <div className="marketing-container mk-hero__grid">
          <div className="mk-hero__text">
            <h1 className="mk-hero__title">{t("site.marketing.home.heroTitle")}</h1>
            <p className="mk-hero__body">{t("site.marketing.home.heroBody")}</p>
            <div className="mk-actions">
              <LinkButton href="/about#contact" variant="primary">
                {t("site.marketing.cta.talkToUs")}
              </LinkButton>
              <Link className="mk-link" to="/features">
                {t("site.marketing.cta.exploreFeatures")}
              </Link>
            </div>
          </div>

          <SchoolDay />
        </div>
      </section>

      <section className="mk-section mk-section--alt" aria-labelledby="mk-register">
        <div className="marketing-container">
          <header className="mk-section__header" {...reveal()}>
            <h2 id="mk-register" className="mk-section__title">
              {t("site.marketing.home.registerTitle")}
            </h2>
            <div>
              <p className="mk-section__lede">{t("site.marketing.home.registerLede")}</p>
              <p className="mk-example">{t("site.marketing.home.exampleNote")}</p>
            </div>
          </header>
          <div {...reveal(1)}>
            <DemoSlot height={440}>
              <RegisterDemo />
            </DemoSlot>
          </div>
        </div>
      </section>

      <section className="mk-section" aria-labelledby="mk-roles">
        <div className="marketing-container">
          <header className="mk-section__header" {...reveal()}>
            <h2 id="mk-roles" className="mk-section__title">
              {t("site.marketing.home.rolesTitle")}
            </h2>
            <p className="mk-section__lede">{t("site.marketing.home.rolesLede")}</p>
          </header>
          <div {...reveal(1)}>
            <DemoSlot height={480}>
              <RoleTour />
            </DemoSlot>
          </div>
        </div>
      </section>

      <section className="mk-section mk-section--alt" aria-labelledby="mk-modules">
        <div className="marketing-container">
          <header className="mk-section__header" {...reveal()}>
            <h2 id="mk-modules" className="mk-section__title">
              {t("site.marketing.home.modulesTitle")}
            </h2>
            <p className="mk-section__lede">{t("site.marketing.home.modulesLede")}</p>
          </header>

          <ol className="mk-index">
            {MODULES.map((id, index) => (
              <li key={id} className="mk-index__item" {...reveal(index)}>
                <span className="mk-index__number" aria-hidden="true">
                  {number(index)}
                </span>
                <div>
                  <h3 className="mk-index__title">
                    {t(`site.marketing.home.modules.${id}.title`)}
                  </h3>
                  <p className="mk-index__body">{t(`site.marketing.home.modules.${id}.body`)}</p>
                </div>
              </li>
            ))}
          </ol>

          <p className="mk-section__more">
            <Link className="mk-link" to="/features">
              {t("site.marketing.cta.exploreFeatures")}
            </Link>
          </p>
        </div>
      </section>

      <section className="mk-section" aria-labelledby="mk-language">
        <div className="marketing-container mk-split">
          <div {...reveal()}>
            <h2 id="mk-language" className="mk-section__title">
              {t("site.marketing.home.languageTitle")}
            </h2>
            <p className="mk-section__lede">{t("site.marketing.home.languageBody")}</p>
          </div>

          <div className="mk-language" {...reveal(1)}>
            <DemoSlot height={150}>
              <LanguageFlip />
            </DemoSlot>
            <table className="mk-pairs">
              <caption className="mk-pairs__caption">
                {t("site.marketing.home.languageCaption")}
              </caption>
              <thead>
                <tr>
                  <th scope="col" lang="en" dir="ltr">
                    English
                  </th>
                  <th scope="col" lang="ar" dir="rtl">
                    العربية
                  </th>
                </tr>
              </thead>
              <tbody>
                {LANGUAGE_PAIRS.map(([english, arabic]) => (
                  <tr key={english}>
                    <td lang="en" dir="ltr">
                      {english}
                    </td>
                    <td lang="ar" dir="rtl">
                      {arabic}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="mk-section mk-section--alt" aria-labelledby="mk-privacy">
        <div className="marketing-container">
          <header className="mk-section__header" {...reveal()}>
            <h2 id="mk-privacy" className="mk-section__title">
              {t("site.marketing.home.privacyTitle")}
            </h2>
          </header>

          <div className="mk-privacy">
            <div className="mk-privacy__demo" {...reveal()}>
              <DemoSlot height={300}>
                <SensitiveDemo />
              </DemoSlot>
            </div>
            <ul className="mk-facts mk-facts--stacked">
              {PRIVACY.map((id, index) => (
                <li key={id} className="mk-facts__item" {...reveal(index)}>
                  <h3 className="mk-facts__title">
                    {t(`site.marketing.home.privacy.${id}.title`)}
                  </h3>
                  <p className="mk-facts__body">{t(`site.marketing.home.privacy.${id}.body`)}</p>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className="mk-section" aria-labelledby="mk-pricing">
        <div className="marketing-container mk-split mk-split--center" {...reveal()}>
          <h2 id="mk-pricing" className="mk-section__title">
            {t("site.marketing.home.pricingTitle")}
          </h2>
          <div>
            <p className="mk-section__lede">{t("site.marketing.home.pricingBody")}</p>
            <p className="mk-section__more">
              <Link className="mk-link" to="/pricing">
                {t("site.marketing.home.pricingLink")}
              </Link>
            </p>
          </div>
        </div>
      </section>

      <ClosingBand />
    </>
  );
}
