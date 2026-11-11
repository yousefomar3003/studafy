import { ApiError } from "@studafy/api-client";
import { Button, Input } from "@studafy/ui";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { z } from "zod";

import { useSeo } from "../../components/Seo";
import { api } from "../../lib/api";
import { useTranslation } from "../../lib/i18n";

import type { FormEvent, ReactNode } from "react";

/** What a failed verification attempt leaves the page offering. */
type Failure =
  | { kind: "invalid" }
  | { kind: "expired" }
  | { kind: "alreadyVerified" }
  | { kind: "rateLimited" }
  | { kind: "other"; message: string };

/**
 * Where the emailed school verification link lands (`/verify-email#token=...`). Public: the person
 * opening it has no account yet.
 *
 * The link used to point at `GET /api/schools/verify-email/{token}` on the web origin, which has no
 * API behind it. It now opens this page instead, which calls that endpoint itself. The token is in
 * the fragment so it never reaches a server log, and it is removed from the address bar once read.
 * Nothing is sent until the button is pressed: mail scanners open links on their own, and the token
 * is one-time, so a scanner's visit must not use it up.
 */
export default function VerifyEmailPage() {
  const { t } = useTranslation();
  useSeo({
    title: t("onboarding.verifyEmail.seoTitle"),
    description: t("onboarding.verifyEmail.seoDescription"),
    path: "/verify-email",
  });

  const { hash, pathname } = useLocation();
  const navigate = useNavigate();
  const [token] = useState(() => new URLSearchParams(hash.slice(1)).get("token"));
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [verifiedSchool, setVerifiedSchool] = useState<string | null>(null);

  useEffect(() => {
    if (hash) navigate(pathname, { replace: true });
  }, [hash, pathname, navigate]);

  async function handleVerify() {
    if (!token) return;
    setSubmitting(true);
    setFailure(null);
    try {
      const { data } = await api.GET("/api/schools/verify-email/{token}", {
        params: { path: { token } },
      });
      setVerifiedSchool(data?.school.name ?? "");
    } catch (caught) {
      setFailure(toFailure(caught, t("onboarding.common.genericError")));
    } finally {
      setSubmitting(false);
    }
  }

  if (verifiedSchool !== null) {
    return (
      <PageShell>
        <h1>{t("onboarding.verifyEmail.verifiedTitle")}</h1>
        <p role="status">
          {verifiedSchool
            ? t("onboarding.verifyEmail.verifiedBody", { school: verifiedSchool })
            : t("onboarding.verifyEmail.verifiedBodyNoName")}
        </p>
        <p>{t("onboarding.verifyEmail.nextStep")}</p>
        <SignInLink />
      </PageShell>
    );
  }

  const offerResend = !token || failure?.kind === "invalid" || failure?.kind === "expired";
  const offerSignIn = failure?.kind === "invalid" || failure?.kind === "alreadyVerified";
  const canRetry =
    Boolean(token) &&
    (failure === null || failure.kind === "rateLimited" || failure.kind === "other");

  return (
    <PageShell>
      <h1>{t("onboarding.verifyEmail.title")}</h1>
      {token ? null : <p role="alert">{t("onboarding.verifyEmail.linkIncomplete")}</p>}
      {failure ? (
        <p role="alert">
          {failure.kind === "other" ? failure.message : t(FAILURE_KEYS[failure.kind])}
        </p>
      ) : null}
      {canRetry ? (
        <>
          {failure ? null : <p>{t("onboarding.verifyEmail.body")}</p>}
          <Button type="button" loading={submitting} onClick={handleVerify}>
            {t("onboarding.verifyEmail.submit")}
          </Button>
        </>
      ) : null}
      {offerSignIn ? <SignInLink /> : null}
      {offerResend ? <ResendVerificationForm /> : null}
    </PageShell>
  );
}

function PageShell({ children }: { children: ReactNode }) {
  return (
    <section className="marketing-section">
      <div className="marketing-container marketing-about-body">{children}</div>
    </section>
  );
}

function SignInLink() {
  const { t } = useTranslation();
  return (
    <p>
      <Link to="/auth/login">{t("onboarding.verifyEmail.signIn")}</Link>
    </p>
  );
}

function toFailure(caught: unknown, fallback: string): Failure {
  const apiError = caught instanceof ApiError ? caught : null;
  switch (apiError?.code) {
    case "VERIFICATION_TOKEN_INVALID":
      return { kind: "invalid" };
    case "VERIFICATION_TOKEN_EXPIRED":
      return { kind: "expired" };
    case "VERIFICATION_TOKEN_CONSUMED":
      return { kind: "alreadyVerified" };
    case "RATE_LIMIT_EXCEEDED":
      return { kind: "rateLimited" };
    default:
      return { kind: "other", message: apiError?.detail ?? fallback };
  }
}

const FAILURE_KEYS = {
  invalid: "onboarding.verifyEmail.linkInvalid",
  expired: "onboarding.verifyEmail.linkExpired",
  alreadyVerified: "onboarding.verifyEmail.alreadyVerified",
  rateLimited: "onboarding.verifyEmail.rateLimited",
} as const;

/** Same rule the API applies to the request body. */
const schoolEmailSchema = z.email().max(320);

/**
 * Asks for a fresh link (`POST /api/schools/resend-verification`). The API answers the same way
 * whether or not the address is registered, so the confirmation is worded as "if".
 */
function ResendVerificationForm() {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = email.trim();
    if (!schoolEmailSchema.safeParse(trimmed).success) {
      setFieldError(t("onboarding.validation.emailInvalid"));
      return;
    }

    setFieldError(null);
    setSubmitting(true);
    setError(null);
    try {
      await api.POST("/api/schools/resend-verification", { body: { email: trimmed } });
      setSentTo(trimmed);
    } catch (caught) {
      const code = caught instanceof ApiError ? caught.code : null;
      setError(
        code === "RATE_LIMIT_EXCEEDED"
          ? t("onboarding.verifyEmail.rateLimited")
          : t("onboarding.common.genericError"),
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (sentTo) {
    return <p role="status">{t("onboarding.verifyEmail.resendSent", { email: sentTo })}</p>;
  }

  return (
    <>
      <h2>{t("onboarding.verifyEmail.resendHeading")}</h2>
      <form
        onSubmit={handleSubmit}
        noValidate
        aria-label={t("onboarding.verifyEmail.resendHeading")}
      >
        <Input
          label={t("onboarding.verifyEmail.resendEmailLabel")}
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={fieldError ?? undefined}
          required
        />
        {error ? <p role="alert">{error}</p> : null}
        <Button type="submit" variant="secondary" loading={submitting}>
          {t("onboarding.verifyEmail.resendSubmit")}
        </Button>
      </form>
    </>
  );
}
