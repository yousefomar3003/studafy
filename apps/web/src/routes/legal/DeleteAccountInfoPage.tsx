import { ApiError } from "@studafy/api-client";
import { Button, Input } from "@studafy/ui";
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { z } from "zod";

import { useSeo } from "../../components/Seo";
import { TurnstileWidget } from "../../components/TurnstileWidget";
import { api } from "../../lib/api";
import { MARKETING_CONTACT_EMAIL, TURNSTILE_SITE_KEY } from "../../lib/config";
import { Trans, useTranslation } from "../../lib/i18n";

import type { TurnstileWidgetHandle } from "../../components/TurnstileWidget";
import type { FormEvent } from "react";

/**
 * Public "delete your account" page (`/legal/delete-account`) — the URL declared in Google Play's
 * Data Safety form and linked from the site footer and the privacy policy. Google Play checks that
 * it works for a reviewer who has never installed the app, so there is no `RequireAuth`: a signed-in
 * user is pointed at `/account/delete`, anyone else asks for an emailed link here
 * (`POST /api/account/deletion-requests`), which opens `/legal/delete-account/confirm`.
 */
export default function DeleteAccountInfoPage() {
  const { t } = useTranslation();
  useSeo({
    title: t("onboarding.legal.deleteAccount.seoTitle"),
    description: t("onboarding.legal.deleteAccount.seoDescription"),
    path: "/legal/delete-account",
  });

  return (
    <section className="marketing-section">
      <div className="marketing-container marketing-about-body">
        <h1>{t("onboarding.legal.deleteAccount.title")}</h1>

        <p>
          <Trans
            i18nKey="onboarding.legal.deleteAccount.intro"
            components={{ privacyLink: <Link to="/privacy" /> }}
          />
        </p>

        <h2>{t("onboarding.legal.deleteAccount.signedInHeading")}</h2>
        <p>
          <Trans
            i18nKey="onboarding.legal.deleteAccount.signedInBody"
            components={{ deleteLink: <Link to="/account/delete" /> }}
          />
        </p>

        <h2>{t("onboarding.legal.deleteAccount.signedOutHeading")}</h2>
        <p>{t("onboarding.legal.deleteAccount.signedOutBody")}</p>
        <DeletionRequestForm />
        <p>
          {MARKETING_CONTACT_EMAIL ? (
            <Trans
              i18nKey="onboarding.legal.deleteAccount.noMailboxWithEmail"
              values={{ email: MARKETING_CONTACT_EMAIL }}
              components={{ mailLink: <a href={`mailto:${MARKETING_CONTACT_EMAIL}`} /> }}
            />
          ) : (
            t("onboarding.legal.deleteAccount.noMailbox")
          )}
        </p>

        <h2>{t("onboarding.legal.deleteAccount.whatHappensHeading")}</h2>
        <p>{t("onboarding.legal.deleteAccount.whatHappensBody")}</p>
        <p>
          <Trans
            i18nKey="onboarding.legal.deleteAccount.retainedBody"
            components={{ privacyLink: <Link to="/privacy" /> }}
          />
        </p>
      </div>
    </section>
  );
}

/** Same rule the API applies to the request body. */
const accountEmailSchema = z.email().max(320);

function DeletionRequestForm() {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [captchaToken, setCaptchaToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const turnstileRef = useRef<TurnstileWidgetHandle>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!accountEmailSchema.safeParse(email.trim()).success) {
      setError(t("onboarding.validation.emailInvalid"));
      return;
    }
    if (!captchaToken) {
      setError(t("onboarding.common.captchaRequired"));
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await api.POST("/api/account/deletion-requests", {
        body: { email: email.trim(), captcha_token: captchaToken },
      });
      setSentTo(email.trim());
    } catch (caught) {
      const code = caught instanceof ApiError ? caught.code : null;
      setError(
        code === "RATE_LIMIT_EXCEEDED"
          ? t("onboarding.legal.deleteAccount.rateLimited")
          : code === "CAPTCHA_INVALID"
            ? t("onboarding.legal.deleteAccount.captchaExpired")
            : t("onboarding.common.genericError"),
      );
      // Turnstile tokens are single-use.
      setCaptchaToken("");
      turnstileRef.current?.reset();
    } finally {
      setSubmitting(false);
    }
  }

  if (sentTo) {
    return <p role="status">{t("onboarding.legal.deleteAccount.sent", { email: sentTo })}</p>;
  }

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      aria-label={t("onboarding.legal.deleteAccount.formLabel")}
    >
      <Input
        label={t("onboarding.legal.deleteAccount.emailLabel")}
        type="email"
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
      />
      <TurnstileWidget
        ref={turnstileRef}
        siteKey={TURNSTILE_SITE_KEY}
        onToken={setCaptchaToken}
        onInvalidate={() => setCaptchaToken("")}
      />
      {error ? <p role="alert">{error}</p> : null}
      <Button type="submit" loading={submitting}>
        {t("onboarding.legal.deleteAccount.submit")}
      </Button>
    </form>
  );
}
