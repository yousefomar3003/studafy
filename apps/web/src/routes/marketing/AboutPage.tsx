import { useSeo } from "../../components/Seo";
import { MARKETING_CONTACT_EMAIL } from "../../lib/config";
import { useFormatters, useTranslation } from "../../lib/i18n";

import { ContactForm } from "./ContactForm";
import { StartSteps } from "./demos/StartSteps";
import { reveal } from "./reveal";

const PRINCIPLES = ["oneRecord", "languages", "schoolData", "trail"] as const;
const NEXT = ["read", "reply", "setup"] as const;

/**
 * About & contact page (`/about`). One page for both, matching the ticket's "about/contact"
 * grouping. Every "Talk to us" button on the site links to the `#contact` form here.
 */
export default function AboutPage() {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();

  useSeo({
    title: t("site.marketing.about.seoTitle"),
    description: t("site.marketing.about.seoDescription"),
    path: "/about",
  });

  return (
    <>
      <section className="mk-hero">
        <div className="marketing-container">
          <h1 className="mk-hero__title">{t("site.marketing.about.heroTitle")}</h1>
          <p className="mk-hero__body">{t("site.marketing.about.heroBody")}</p>
        </div>
      </section>

      <section className="marketing-section">
        {/* Left-aligned with the headings; the legal pages keep the centred reading column. */}
        <div className="marketing-container">
          <div className="marketing-about-body">
            <p {...reveal(0)}>{t("site.marketing.about.body1")}</p>
            <p {...reveal(1)}>{t("site.marketing.about.body2")}</p>
            <p {...reveal(2)}>{t("site.marketing.about.body3")}</p>
          </div>
        </div>
      </section>

      <section className="mk-section mk-section--alt" aria-labelledby="mk-start">
        <div className="marketing-container">
          <header className="mk-section__header" {...reveal()}>
            <h2 id="mk-start" className="mk-section__title">
              {t("site.marketing.about.startTitle")}
            </h2>
            <p className="mk-section__lede">{t("site.marketing.about.startLede")}</p>
          </header>
          <div {...reveal(1)}>
            <StartSteps />
          </div>
        </div>
      </section>

      <section className="mk-section" aria-labelledby="mk-principles">
        <div className="marketing-container">
          <header className="mk-section__header" {...reveal()}>
            <h2 id="mk-principles" className="mk-section__title">
              {t("site.marketing.about.principlesTitle")}
            </h2>
          </header>
          <ol className="mk-principles">
            {PRINCIPLES.map((id, index) => (
              <li key={id} className="mk-principles__item" {...reveal(index)}>
                <span className="mk-principles__number" aria-hidden="true">
                  {formatNumber(index + 1, { minimumIntegerDigits: 2 })}
                </span>
                <h3 className="mk-facts__title">
                  {t(`site.marketing.about.principles.${id}.title`)}
                </h3>
                <p className="mk-facts__body">{t(`site.marketing.about.principles.${id}.body`)}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section id="contact" className="mk-section mk-section--alt" aria-labelledby="mk-contact">
        <div className="marketing-container mk-contact">
          <header className="mk-contact__intro" {...reveal()}>
            <h2 id="mk-contact" className="mk-section__title">
              {t("site.marketing.about.contactTitle")}
            </h2>
            <p className="mk-section__lede">{t("site.marketing.about.contactLede")}</p>
            <h3 className="mk-contact__next-title">{t("site.marketing.about.nextTitle")}</h3>
            <ol className="mk-contact__next">
              {NEXT.map((id) => (
                <li key={id}>{t(`site.marketing.about.next.${id}`)}</li>
              ))}
            </ol>
            {MARKETING_CONTACT_EMAIL ? (
              <p className="mk-contact__email">
                <span className="mk-label">{t("site.marketing.about.emailLabel")}</span>
                <a className="mk-link" href={`mailto:${MARKETING_CONTACT_EMAIL}`}>
                  {MARKETING_CONTACT_EMAIL}
                </a>
              </p>
            ) : null}
          </header>

          <div className="mk-contact__form" {...reveal(1)}>
            <ContactForm />
          </div>
        </div>
      </section>
    </>
  );
}
