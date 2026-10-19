// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { beforeAll, describe, expect, test } from "bun:test";

import { errorHandlerMiddleware } from "../../middleware/errorHandler";
import { KeyStore } from "../auth/jwt/key-store";
import { signAccessToken } from "../auth/jwt/sign";

import {
  APPLICANT_COOKIE_NAME,
  signApplicantSession,
  verifyApplicantSession,
} from "./applicant-session";
import { applicationRedirectUri, schoolApplicationOAuthRoutes } from "./oauth-routes";
import { schoolApplicantRoutes } from "./routes";
import { safeStorageFilename, slugBase } from "./service";

import type { ApplicantSessionConfig } from "./applicant-session";
import type { ApplicationOAuthDependencies } from "./oauth-routes";
import type { Database } from "../../db";
import type { Logger } from "../../logger";

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
} as unknown as Logger;
/** The routes under test must never reach the database on these paths. */
const untouchableDatabase = new Proxy(
  {},
  {
    get() {
      throw new Error("database must not be touched");
    },
  },
) as Database;

let sessionConfig: ApplicantSessionConfig;

beforeAll(async () => {
  const keyStore = new KeyStore(24 * 60 * 60 * 1000);
  await keyStore.init();
  sessionConfig = { keyStore, issuer: "https://api.test", audience: "studafy-api" };
});

const identity = {
  provider: "google" as const,
  subject: "google-sub-1",
  email: "owner@school.example",
  name: "Sara Al-Ahmad",
};

describe("applicant session", () => {
  test("round-trips the verified identity", async () => {
    const token = await signApplicantSession(sessionConfig, identity);
    expect(await verifyApplicantSession(sessionConfig, token)).toEqual(identity);
  });

  test("rejects a normal access token, which carries a different audience", async () => {
    const accessToken = await signAccessToken(
      sessionConfig.keyStore,
      {
        sub: "00000000-0000-4000-8000-000000000001",
        school_id: "00000000-0000-4000-8000-000000000002",
        roles: ["ORG_ADMIN"],
        entitlements_ver: 1,
        channel: "web",
        subscription_status: "active",
      },
      { issuer: sessionConfig.issuer, audience: sessionConfig.audience, ttlSeconds: 60 },
    );
    expect(await verifyApplicantSession(sessionConfig, accessToken)).toBeNull();
  });

  test("rejects garbage", async () => {
    expect(await verifyApplicantSession(sessionConfig, "not-a-jwt")).toBeNull();
  });
});

describe("applicant routes", () => {
  test("GET /me without the applicant cookie is 401 SCHOOL_APPLICATION_SESSION_REQUIRED", async () => {
    const app = schoolApplicantRoutes(untouchableDatabase, null, sessionConfig);
    app.onError(errorHandlerMiddleware(silentLogger));
    const res = await app.request("/api/school-applications/me");
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe(
      "SCHOOL_APPLICATION_SESSION_REQUIRED",
    );
  });

  test("sign-out clears the cookie", async () => {
    const app = schoolApplicantRoutes(untouchableDatabase, null, sessionConfig);
    const res = await app.request("/api/school-applications/me/sign-out", { method: "POST" });
    expect(res.status).toBe(204);
    expect(res.headers.get("set-cookie")).toContain(`${APPLICANT_COOKIE_NAME}=;`);
  });
});

describe("sign-up OAuth", () => {
  const PROVIDER_CONFIG = {
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "https://api.test/api/auth/oauth/google/callback",
    frontendUrl: "https://web.example",
  };

  function appWith(overrides: Partial<ApplicationOAuthDependencies> = {}) {
    return schoolApplicationOAuthRoutes(untouchableDatabase, sessionConfig, silentLogger, {
      getProviderConfig: () => PROVIDER_CONFIG,
      verifyIdentity: () =>
        Promise.resolve({ sub: "google-sub-1", email: " Owner@School.example ", name: "Sara" }),
      identityExists: () => Promise.resolve(false),
      ...overrides,
    });
  }

  async function startFlow(app: ReturnType<typeof appWith>): Promise<string> {
    const res = await app.request("/api/auth/oauth/google/school-application/start");
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://api.test/api/auth/oauth/google/school-application/callback",
    );
    return location.searchParams.get("state")!;
  }

  test("derives the application callback from the login callback's origin", () => {
    expect(
      applicationRedirectUri("microsoft", "https://api.test/api/auth/oauth/microsoft/callback"),
    ).toBe("https://api.test/api/auth/oauth/microsoft/school-application/callback");
  });

  test("a verified identity gets the applicant cookie and lands on the form", async () => {
    const app = appWith();
    const state = await startFlow(app);
    const res = await app.request(
      `/api/auth/oauth/google/school-application/callback?code=abc&state=${state}`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://web.example/signup/apply");
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toContain(`${APPLICANT_COOKIE_NAME}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/api/school-applications/me");

    const token = /studafy_applicant=([^;]+)/.exec(cookie)![1]!;
    expect(await verifyApplicantSession(sessionConfig, token)).toEqual({
      provider: "google",
      subject: "google-sub-1",
      email: "owner@school.example",
      name: "Sara",
    });
  });

  test("an identity that already has an account is sent back to sign in, without a cookie", async () => {
    const app = appWith({ identityExists: () => Promise.resolve(true) });
    const state = await startFlow(app);
    const res = await app.request(
      `/api/auth/oauth/google/school-application/callback?code=abc&state=${state}`,
    );
    expect(res.headers.get("location")).toBe(
      "https://web.example/signup?error=SCHOOL_APPLICATION_ACCOUNT_EXISTS",
    );
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("an unknown state redirects with OAUTH_STATE_INVALID", async () => {
    const res = await appWith().request(
      "/api/auth/oauth/google/school-application/callback?code=abc&state=forged",
    );
    expect(res.headers.get("location")).toBe(
      "https://web.example/signup?error=OAUTH_STATE_INVALID",
    );
  });

  test("a declined consent screen redirects with OAUTH_CANCELLED", async () => {
    const res = await appWith().request(
      "/api/auth/oauth/google/school-application/callback?error=access_denied",
    );
    expect(res.headers.get("location")).toBe("https://web.example/signup?error=OAUTH_CANCELLED");
  });
});

describe("helpers", () => {
  test("slugBase builds a schema-valid slug, falling back for non-Latin names", () => {
    expect(slugBase("Al Noor International School")).toBe("al-noor-international-school");
    expect(slugBase("École Saint-Exupéry")).toBe("ecole-saint-exupery");
    expect(slugBase("مدرسة النور")).toBe("school");
    expect(slugBase("AB")).toBe("ab-school");
    const long = slugBase("x".repeat(80));
    expect(long.length).toBeLessThanOrEqual(50);
    expect(long).toBe("x".repeat(50));
  });

  test("safeStorageFilename keeps keys to a safe ASCII subset", () => {
    expect(safeStorageFilename("licence 2026.pdf")).toBe("licence_2026.pdf");
    expect(safeStorageFilename("../../etc/passwd")).toBe("etc_passwd");
    expect(safeStorageFilename("رخصة.png")).toBe("png");
    expect(safeStorageFilename("")).toBe("proof");
  });
});
