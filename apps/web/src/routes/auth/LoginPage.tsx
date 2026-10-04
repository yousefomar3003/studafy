import { ApiError } from "@studafy/api-client";
import { Button, Input } from "@studafy/ui";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { BrandLogo } from "../../components/BrandLogo";
import { Loading } from "../../components/Loading";
import {
  consumeReturnTo,
  loginWithPassword,
  useAuthStatus,
  useOAuthLogin,
  useSessionStore,
} from "../../lib/auth";
import { SHOW_MOCK_LOGIN } from "../../lib/config";
import { useTranslation } from "../../lib/i18n";

import type { TFunction } from "i18next";
import type { FormEvent } from "react";

import "./login-page.css";

/**
 * Seeded demo personas offered by the dev-only quick sign-in, grouped by role. Mirrors
 * db/seeds/mock-credentials.ts (the web app cannot import the seed package) — update both together.
 * Only rendered when {@link SHOW_MOCK_LOGIN}. Group and role words are translation keys under
 * `site.login.dev`; person names are proper nouns and stay as-is.
 */
const DEMO_PERSONA_GROUPS: readonly {
  readonly labelKey: string;
  readonly personas: readonly {
    readonly email: string;
    readonly name: string;
    readonly roleKey?: string;
  }[];
}[] = [
  {
    labelKey: "site.login.dev.groups.administrators",
    personas: [
      {
        email: "superadmin@demo.studafy.test",
        name: "Sana Al-Rashid",
        roleKey: "site.login.dev.roles.superAdmin",
      },
      {
        email: "admin@demo.studafy.test",
        name: "Omar Haddad",
        roleKey: "site.login.dev.roles.schoolAdmin",
      },
    ],
  },
  {
    labelKey: "site.login.dev.groups.teachers",
    personas: [
      {
        email: "layla.nasser@demo.studafy.test",
        name: "Layla Nasser",
        roleKey: "site.login.dev.roles.science",
      },
      {
        email: "hassan.ibrahim@demo.studafy.test",
        name: "Hassan Ibrahim",
        roleKey: "site.login.dev.roles.math",
      },
      {
        email: "mona.farouk@demo.studafy.test",
        name: "Mona Farouk",
        roleKey: "site.login.dev.roles.arts",
      },
      {
        email: "yusuf.karim@demo.studafy.test",
        name: "Yusuf Karim",
        roleKey: "site.login.dev.roles.teachingAssistant",
      },
    ],
  },
  {
    labelKey: "site.login.dev.groups.students",
    personas: [
      { email: "yara.khalil@demo.studafy.test", name: "Yara Khalil" },
      { email: "adam.fares@demo.studafy.test", name: "Adam Fares" },
      { email: "nour.saleh@demo.studafy.test", name: "Nour Saleh" },
      { email: "zaid.mansour@demo.studafy.test", name: "Zaid Mansour" },
      { email: "lina.haddad@demo.studafy.test", name: "Lina Haddad" },
      { email: "omar.darwish@demo.studafy.test", name: "Omar Darwish" },
      { email: "huda.rahman@demo.studafy.test", name: "Huda Rahman" },
      { email: "sami.aziz@demo.studafy.test", name: "Sami Aziz" },
    ],
  },
  {
    labelKey: "site.login.dev.groups.parents",
    personas: [
      { email: "khalil.parent@demo.studafy.test", name: "Rania Khalil" },
      { email: "fares.parent@demo.studafy.test", name: "Bassel Fares" },
      { email: "saleh.parent@demo.studafy.test", name: "Maha Saleh" },
      { email: "mansour.parent@demo.studafy.test", name: "Tariq Mansour" },
      { email: "haddad.parent@demo.studafy.test", name: "Dalia Haddad" },
      { email: "darwish.parent@demo.studafy.test", name: "Karim Darwish" },
    ],
  },
];

const DEFAULT_DEMO_EMAIL = "admin@demo.studafy.test";

function passwordLoginErrorMessage(error: unknown, t: TFunction): string {
  if (error instanceof ApiError) {
    switch (error.status) {
      case 401:
        return t("site.login.errors.invalidCredentials");
      case 403:
        return error.detail ?? t("site.login.errors.suspended");
      case 404:
        return t("site.login.errors.passwordDisabled");
      case 429:
        return t("site.login.errors.rateLimited");
    }
  }
  return t("site.login.errors.generic");
}

/**
 * Login page (`/auth/login`).
 *
 * Two entry paths:
 *   - redirected here by {@link RequireAuth} when a guarded route was reached unauthenticated or
 *     with a dead session. The original route was saved to the return-to, and the OAuth round trip
 *     will restore it (`?reason=expired` when the session died mid-life).
 *   - visited directly. If the refresh cookie is still valid this page recovers the session itself
 *     (`restore()` is single-flight) and forwards to the return-to or the portal, so a user who
 *     merely navigated here with a live session never sees the provider buttons.
 *
 * Sign-in options: Google / Microsoft OAuth, email + password (sets the refresh cookie, then
 * `restore()` completes the session exactly as the OAuth callback does), and — dev/E2E only — the
 * mock provider with a persona picker (`?login_hint=` preselects one).
 */
export default function LoginPage() {
  const { t } = useTranslation();
  const status = useAuthStatus();
  const store = useSessionStore();
  const beginOAuth = useOAuthLogin();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const loginHint = searchParams.get("login_hint") ?? undefined;
  const [mockEmail, setMockEmail] = useState(loginHint ?? DEFAULT_DEMO_EMAIL);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Re-check the cookie when this page is entered cold; harmless when already checked.
  useEffect(() => {
    void store.restore();
  }, [store]);

  const handled = useRef(false);
  useEffect(() => {
    if (status === "authenticated" && !handled.current) {
      handled.current = true;
      void navigate(consumeReturnTo() ?? "/portal", { replace: true });
    }
  }, [status, navigate]);

  if (status === "restoring" || status === "authenticated") {
    return <Loading />;
  }

  const sessionExpired = searchParams.get("reason") === "expired";
  const loginHintIsCustom =
    loginHint !== undefined &&
    !DEMO_PERSONA_GROUPS.some((group) =>
      group.personas.some((persona) => persona.email === loginHint),
    );

  async function handlePasswordSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      await loginWithPassword(email.trim(), password);
      // The refresh cookie is now set; restore() turns it into a session and the effect above
      // forwards to the return-to.
      const next = await store.restore();
      if (next !== "authenticated") {
        setFormError(t("site.login.errors.sessionNotStarted"));
      }
    } catch (error) {
      setFormError(passwordLoginErrorMessage(error, t));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login">
      <section className="login__card" aria-labelledby="login-heading">
        <Link to="/" className="login__brand" aria-label={t("shell.homeLink")}>
          <BrandLogo size="lg" badge />
        </Link>

        <header className="login__header">
          <h1 id="login-heading">{t("site.login.title")}</h1>
          <p className="login__subtitle">{t("site.login.subtitle")}</p>
        </header>

        {sessionExpired && (
          <p role="status" className="login__notice">
            {t("site.login.sessionExpired")}
          </p>
        )}

        <div className="login__providers">
          <Button
            type="button"
            variant="secondary"
            fullWidth
            leadingIcon={<GoogleIcon />}
            onClick={() => beginOAuth("google")}
          >
            {t("site.login.continueWith", { provider: "Google" })}
          </Button>
          <Button
            type="button"
            variant="secondary"
            fullWidth
            leadingIcon={<MicrosoftIcon />}
            onClick={() => beginOAuth("microsoft")}
          >
            {t("site.login.continueWith", { provider: "Microsoft" })}
          </Button>
        </div>

        <div className="login__divider" role="separator">
          <span>{t("site.login.divider")}</span>
        </div>

        <form className="login__form" onSubmit={(event) => void handlePasswordSubmit(event)}>
          <Input
            label={t("site.login.emailLabel")}
            type="email"
            name="email"
            autoComplete="username"
            placeholder="you@school.edu"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <Input
            label={t("site.login.passwordLabel")}
            type="password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          {formError && (
            <p role="alert" className="login__error">
              {formError}
            </p>
          )}
          <Button type="submit" variant="primary" fullWidth loading={submitting}>
            {t("site.login.submit")}
          </Button>
        </form>

        {SHOW_MOCK_LOGIN && (
          <div className="login__dev">
            <p className="login__dev-title">
              <span className="login__dev-badge">{t("site.login.dev.badge")}</span>{" "}
              {t("site.login.dev.title")}
            </p>
            <label className="login__dev-label" htmlFor="login-mock-persona">
              {t("site.login.dev.selectLabel")}
            </label>
            <select
              id="login-mock-persona"
              className="login__dev-select"
              value={mockEmail}
              onChange={(event) => setMockEmail(event.target.value)}
            >
              {loginHintIsCustom && <option value={loginHint}>{loginHint}</option>}
              {DEMO_PERSONA_GROUPS.map((group) => (
                <optgroup key={group.labelKey} label={t(group.labelKey)}>
                  {group.personas.map((persona) => (
                    <option key={persona.email} value={persona.email}>
                      {persona.roleKey
                        ? t("site.login.dev.personaWithRole", {
                            role: t(persona.roleKey),
                            name: persona.name,
                          })
                        : persona.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <Button
              type="button"
              variant="tertiary"
              fullWidth
              onClick={() => beginOAuth("mock", mockEmail || undefined)}
            >
              {t("site.login.continueWith", { provider: "Mock" })}
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path
        fill="#FFC107"
        d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"
      />
      <path
        fill="#FF3D00"
        d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"
      />
    </svg>
  );
}

function MicrosoftIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 21 21" aria-hidden="true" focusable="false">
      <rect x="1" y="1" width="9" height="9" fill="#F25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
      <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
      <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
    </svg>
  );
}
