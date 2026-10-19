import { useEffect } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { BrandLogo } from "../../components/BrandLogo";
import { LinkButton } from "../../components/LinkButton";
import { GoogleIcon, MicrosoftIcon } from "../../components/ProviderIcons";
import { useTranslation } from "../../lib/i18n";

import { signupOAuthStartUrl, useApplicantQuery } from "./applicant-api";

import "../auth/login-page.css";
import "./signup.css";

/** Callback failures the page explains; anything else gets the generic message. */
const KNOWN_ERRORS = new Set([
  "OAUTH_CANCELLED",
  "OAUTH_STATE_INVALID",
  "OAUTH_EMAIL_NOT_VERIFIED",
  "SCHOOL_APPLICATION_ACCOUNT_EXISTS",
]);

/**
 * Website sign-up for a school (`/signup`). Studafy accounts are Google or Microsoft only, so the
 * first step is choosing one; the API's sign-up OAuth callback brings the person back to
 * `/signup/apply` with an applicant session, or here with `?error=<CODE>`.
 */
export default function SignupPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const error = params.get("error");
  const { data: applicant } = useApplicantQuery();

  // Already signed in as an applicant (e.g. came back later): straight to the form / status.
  useEffect(() => {
    if (applicant && !error) navigate("/signup/apply", { replace: true });
  }, [applicant, error, navigate]);

  return (
    <div className="login">
      <section className="login__card signup__card" aria-labelledby="signup-heading">
        <Link to="/" className="login__brand" aria-label={t("shell.homeLink")}>
          <BrandLogo size="lg" tone="navy" />
        </Link>

        <header className="login__header">
          <h1 id="signup-heading">{t("onboarding.signup.title")}</h1>
          <p className="login__subtitle">{t("onboarding.signup.subtitle")}</p>
        </header>

        {error ? (
          <p role="alert" className="login__notice">
            {t(`onboarding.signup.errors.${KNOWN_ERRORS.has(error) ? error : "generic"}`)}
            {error === "SCHOOL_APPLICATION_ACCOUNT_EXISTS" ? (
              <>
                {" "}
                <Link to="/auth/login">{t("onboarding.signup.signInInstead")}</Link>
              </>
            ) : null}
          </p>
        ) : null}

        <ol className="signup__steps">
          <li>{t("onboarding.signup.steps.account")}</li>
          <li>{t("onboarding.signup.steps.details")}</li>
          <li>{t("onboarding.signup.steps.review")}</li>
        </ol>

        <div className="login__providers">
          <LinkButton variant="secondary" fullWidth href={signupOAuthStartUrl("google")}>
            <span className="signup__provider">
              <GoogleIcon />
              {t("site.login.continueWith", { provider: "Google" })}
            </span>
          </LinkButton>
          <LinkButton variant="secondary" fullWidth href={signupOAuthStartUrl("microsoft")}>
            <span className="signup__provider">
              <MicrosoftIcon />
              {t("site.login.continueWith", { provider: "Microsoft" })}
            </span>
          </LinkButton>
        </div>

        <p className="login__subtitle signup__footnote">
          {t("onboarding.signup.haveAccount")}{" "}
          <Link to="/auth/login">{t("onboarding.signup.signIn")}</Link>
        </p>
      </section>
    </div>
  );
}
