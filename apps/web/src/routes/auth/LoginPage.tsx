import { Button } from "@studafy/ui";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { BrandLogo } from "../../components/BrandLogo";
import { Loading } from "../../components/Loading";
import { GoogleIcon, MicrosoftIcon } from "../../components/ProviderIcons";
import {
  consumeReturnTo,
  resolveRoleHome,
  useAuthStatus,
  useOAuthLogin,
  useSessionStore,
} from "../../lib/auth";
import { SHOW_MOCK_LOGIN } from "../../lib/config";
import { useTranslation } from "../../lib/i18n";

import "./login-page.css";

/**
 * Seeded demo personas offered by the dev-only quick sign-in, grouped by role. Only roles that can
 * use the website are listed: students, parents, teachers and attendance officers sign in on the
 * mobile app (`MOBILE_ONLY_ROLES`), and the API refuses them a web session. Mirrors
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
      {
        email: "principal@demo.studafy.test",
        name: "Samir Qasem",
        roleKey: "site.login.dev.roles.principal",
      },
      {
        email: "finance@demo.studafy.test",
        name: "Reem Saadeh",
        roleKey: "site.login.dev.roles.finance",
      },
    ],
  },
];

const DEFAULT_DEMO_EMAIL = "admin@demo.studafy.test";

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
 * Sign-in options: Google / Microsoft OAuth only — schools sign in through the identity provider
 * they already manage, so the page offers no email + password form. Dev/E2E builds also get the
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

  // Re-check the cookie when this page is entered cold; harmless when already checked.
  useEffect(() => {
    void store.restore();
  }, [store]);

  const handled = useRef(false);
  useEffect(() => {
    if (status === "authenticated" && !handled.current) {
      handled.current = true;
      void navigate(consumeReturnTo() ?? resolveRoleHome(store.getRoles()), { replace: true });
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

  return (
    <div className="login">
      <section className="login__card" aria-labelledby="login-heading">
        <Link to="/" className="login__brand" aria-label={t("shell.homeLink")}>
          <BrandLogo size="lg" tone="navy" />
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
