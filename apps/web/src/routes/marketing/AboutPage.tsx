import { Card } from "@studafy/ui";

import { useSeo } from "../../components/Seo";
import { MARKETING_CONTACT_EMAIL } from "../../lib/config";
import { useTranslation } from "../../lib/i18n";

import { ContactForm } from "./ContactForm";

/**
 * About & contact page (`/about`). One page for both, matching the ticket's "about/contact"
 * grouping. Every "Talk to us" button on the site links to the `#contact` form here.
 */
export default function AboutPage() {
  const { t } = useTranslation();

  useSeo({
    title: t("site.marketing.about.seoTitle"),
    description: t("site.marketing.about.seoDescription"),
    path: "/about",
  });

  return (
    <>
      <section className="marketing-hero">
        <div className="marketing-container">
          <h1 className="marketing-hero__title">{t("site.marketing.about.heroTitle")}</h1>
          <p className="marketing-hero__subtitle">{t("site.marketing.about.heroSubtitle")}</p>
        </div>
      </section>

      <section className="marketing-section">
        <div className="marketing-container marketing-about-body">
          <p>{t("site.marketing.about.body1")}</p>
          <p>{t("site.marketing.about.body2")}</p>
          <p>{t("site.marketing.about.body3")}</p>
        </div>
      </section>

      <section id="contact" className="marketing-section marketing-section--muted">
        <div className="marketing-container marketing-contact">
          <div className="marketing-section__heading marketing-contact__heading">
            <span className="marketing-section__eyebrow">
              {t("site.marketing.about.contactEyebrow")}
            </span>
            <h2 className="marketing-section__title">{t("site.marketing.about.contactTitle")}</h2>
            <p className="marketing-section__lede">{t("site.marketing.about.contactLede")}</p>
          </div>

          <div className="marketing-contact__card">
            <Card elevation={2}>
              <Card.Body>
                <ContactForm />
              </Card.Body>
            </Card>
          </div>

          {MARKETING_CONTACT_EMAIL ? (
            <p className="marketing-contact-card">
              <span className="marketing-contact-card__label">
                {t("site.marketing.about.emailLabel")}
              </span>
              <a
                className="marketing-contact-card__email"
                href={`mailto:${MARKETING_CONTACT_EMAIL}`}
              >
                {MARKETING_CONTACT_EMAIL}
              </a>
            </p>
          ) : null}
        </div>
      </section>
    </>
  );
}
