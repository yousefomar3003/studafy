import { Link } from "react-router-dom";

import { useSeo } from "../../components/Seo";
import { MARKETING_CONTACT_EMAIL } from "../../lib/config";
import { Trans, useFormatters, useLocale, useTranslation } from "../../lib/i18n";

const LAST_UPDATED = "2026-10-01";

/**
 * Public privacy policy (`/privacy`) — required by both app stores' listing forms
 * (`apps/mobile/store/listing-metadata.md`) and by `apps/mobile/store/privacy-labels.md`'s data
 * mapping, which this page's content mirrors rather than restates independently. No `RequireAuth`:
 * both stores' review flows, and any visitor deciding whether to sign up, need to reach this
 * without an account.
 *
 * This is a working draft grounded in what the codebase actually does (see privacy-labels.md's
 * per-data-type sourcing), not boilerplate — but it is still legal copy, and should get a
 * compliance/legal review before a store submission relies on it as final.
 */
export default function PrivacyPolicyPage() {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const { locale } = useLocale();
  useSeo({
    title: t("onboarding.legal.privacy.seoTitle"),
    description: t("onboarding.legal.privacy.seoDescription"),
    path: "/privacy",
  });

  const strong = { strong: <strong /> };

  return (
    <section className="marketing-section">
      <div className="marketing-container marketing-about-body">
        <h1>{t("onboarding.legal.privacy.title")}</h1>
        <p>
          {t("onboarding.legal.privacy.lastUpdated", {
            date:
              locale === "en"
                ? LAST_UPDATED
                : formatDate(new Date(`${LAST_UPDATED}T00:00:00Z`), {
                    dateStyle: "long",
                    timeZone: "UTC",
                  }),
          })}
        </p>

        <p>{t("onboarding.legal.privacy.intro")}</p>

        <h2>{t("onboarding.legal.privacy.accountsHeading")}</h2>
        <p>{t("onboarding.legal.privacy.accountsBody")}</p>

        <h2>{t("onboarding.legal.privacy.collectHeading")}</h2>
        <p>{t("onboarding.legal.privacy.collectIntro")}</p>
        <ul>
          <li>
            <Trans i18nKey="onboarding.legal.privacy.collectEducation" components={strong} />
          </li>
          <li>
            <Trans i18nKey="onboarding.legal.privacy.collectIdentifiers" components={strong} />
          </li>
          <li>
            <Trans i18nKey="onboarding.legal.privacy.collectDiagnostics" components={strong} />
          </li>
          <li>
            <Trans i18nKey="onboarding.legal.privacy.collectContent" components={strong} />
          </li>
          <li>
            <Trans i18nKey="onboarding.legal.privacy.collectBilling" components={strong} />
          </li>
          <li>
            <Trans i18nKey="onboarding.legal.privacy.collectAi" components={strong} />
          </li>
        </ul>
        <p>{t("onboarding.legal.privacy.collectContact")}</p>

        <h2>{t("onboarding.legal.privacy.rightsHeading")}</h2>
        <p>{t("onboarding.legal.privacy.rightsIntro")}</p>
        <ul>
          <li>
            <Trans
              i18nKey="onboarding.legal.privacy.rightsSignedIn"
              components={{ settingsLink: <Link to="/account/delete" /> }}
            />
          </li>
          <li>
            <Trans
              i18nKey="onboarding.legal.privacy.rightsSignedOut"
              components={{ deleteLink: <Link to="/legal/delete-account" /> }}
            />
          </li>
          <li>{t("onboarding.legal.privacy.rightsCopy")}</li>
        </ul>
        <p>{t("onboarding.legal.privacy.rightsDeletion")}</p>

        <h2>{t("onboarding.legal.privacy.contactHeading")}</h2>
        {MARKETING_CONTACT_EMAIL ? (
          <p>
            <Trans
              i18nKey="onboarding.legal.privacy.contactBody"
              values={{ email: MARKETING_CONTACT_EMAIL }}
              components={{ mailLink: <a href={`mailto:${MARKETING_CONTACT_EMAIL}`} /> }}
            />
          </p>
        ) : (
          <p>Contact address not yet configured (set VITE_MARKETING_CONTACT_EMAIL).</p>
        )}
      </div>
    </section>
  );
}
