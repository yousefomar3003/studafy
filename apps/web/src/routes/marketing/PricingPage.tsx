import { LinkButton } from "../../components/LinkButton";
import { useSeo } from "../../components/Seo";
import { useTranslation } from "../../lib/i18n";

import { SchoolSize } from "./demos/SchoolSize";
import { reveal } from "./reveal";

/** Keys under `site.marketing.pricing.included`, translated at render time. */
const INCLUDED_FOR_EVERY_SCHOOL = [
  "academics",
  "homework",
  "finance",
  "families",
  "records",
  "oversight",
] as const;

const FAQ = ["free", "ai", "data", "devices", "arabic"] as const;

/**
 * Pricing page (`/pricing`). Studafy is free for schools (migration 000145 puts every school on the
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
      <section className="mk-hero">
        <div className="marketing-container">
          <h1 className="mk-hero__title">{t("site.marketing.pricing.heroTitle")}</h1>
          <p className="mk-hero__body">{t("site.marketing.pricing.heroBody")}</p>
        </div>
      </section>

      <section className="mk-section mk-section--alt" aria-labelledby="mk-size">
        <div className="marketing-container mk-split mk-split--center">
          <div {...reveal()}>
            <h2 id="mk-size" className="mk-section__title">
              {t("site.marketing.pricing.sizeTitle")}
            </h2>
            <p className="mk-section__lede">{t("site.marketing.pricing.sizeNote")}</p>
          </div>
          <div {...reveal(1)}>
            <SchoolSize />
          </div>
        </div>
      </section>

      <section className="mk-section">
        <div className="marketing-container mk-plans">
          <article className="mk-plan mk-plan--main" aria-labelledby="mk-plan-school" {...reveal()}>
            <h2 id="mk-plan-school" className="mk-plan__name">
              {t("site.marketing.pricing.schoolTitle")}
            </h2>
            <p className="mk-plan__price">{t("site.marketing.pricing.schoolPrice")}</p>
            <p className="mk-plan__note">{t("site.marketing.pricing.schoolNote")}</p>
            <ul className="mk-plan__list">
              {INCLUDED_FOR_EVERY_SCHOOL.map((item, index) => (
                <li key={item} {...reveal(index + 1)}>
                  {t(`site.marketing.pricing.included.${item}`)}
                </li>
              ))}
            </ul>
            <LinkButton href="/about#contact" variant="primary">
              {t("site.marketing.pricing.contactUs")}
            </LinkButton>
          </article>

          <article className="mk-plan" aria-labelledby="mk-plan-ai" {...reveal(1)}>
            <p className="mk-label">{t("site.marketing.pricing.addOnLabel")}</p>
            <h2 id="mk-plan-ai" className="mk-plan__name">
              {t("site.marketing.pricing.addOnTitle")}
            </h2>
            <p className="mk-plan__note">{t("site.marketing.pricing.addOnBody")}</p>
            <p className="mk-plan__aside">{t("site.marketing.pricing.addOnNote")}</p>
          </article>
        </div>
      </section>

      <section className="mk-section mk-section--alt" aria-labelledby="mk-faq">
        <div className="marketing-container mk-split">
          <h2 id="mk-faq" className="mk-section__title" {...reveal()}>
            {t("site.marketing.pricing.faqTitle")}
          </h2>
          <div className="mk-faq">
            {FAQ.map((id, index) => (
              <details key={id} className="mk-faq__item" {...reveal(index)}>
                <summary className="mk-faq__question">
                  {t(`site.marketing.pricing.faq.${id}.q`)}
                </summary>
                <p className="mk-faq__answer">{t(`site.marketing.pricing.faq.${id}.a`)}</p>
              </details>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
