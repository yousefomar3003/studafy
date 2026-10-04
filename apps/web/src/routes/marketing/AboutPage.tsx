import { Card } from "@studafy/ui";

import { useSeo } from "../../components/Seo";
import { MARKETING_CONTACT_EMAIL } from "../../lib/config";
import { useTranslation } from "../../lib/i18n";

/** About & contact page (`/about`). One page for both, matching the ticket's "about/contact" grouping. */
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
        <div className="marketing-container">
          <div className="marketing-section__heading">
            <span className="marketing-section__eyebrow">
              {t("site.marketing.about.contactEyebrow")}
            </span>
            <h2 className="marketing-section__title">{t("site.marketing.about.contactTitle")}</h2>
            <p className="marketing-section__lede">{t("site.marketing.about.contactLede")}</p>
          </div>

          <Card>
            <Card.Body>
              <div className="marketing-contact-card">
                <span className="marketing-contact-card__label">
                  {t("site.marketing.about.emailLabel")}
                </span>
                {MARKETING_CONTACT_EMAIL ? (
                  <a
                    className="marketing-contact-card__email"
                    href={`mailto:${MARKETING_CONTACT_EMAIL}`}
                  >
                    {MARKETING_CONTACT_EMAIL}
                  </a>
                ) : (
                  // Dev/config-only hint (names an env var), deliberately not translated.
                  <span className="marketing-contact-card__email">
                    Contact address not yet configured (set VITE_MARKETING_CONTACT_EMAIL)
                  </span>
                )}
              </div>
            </Card.Body>
          </Card>
        </div>
      </section>
    </>
  );
}
