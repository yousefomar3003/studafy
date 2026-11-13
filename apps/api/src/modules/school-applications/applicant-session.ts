/**
 * The applicant session: who is filling in a school sign-up application.
 *
 * An applicant has signed in with Google or Microsoft but has no Studafy account and no school, so
 * none of the normal session machinery applies -- access tokens are bound to a `school_id`, and
 * `app.oauth_identities` rows to a user. Instead the OAuth callback hands the browser a short-lived
 * RS256 JWT carrying the verified identity, signed by the same KeyStore as access tokens but with
 * its own audience, so neither token can ever be accepted in place of the other.
 *
 * Delivered as an HttpOnly, SameSite=Strict cookie scoped to `/api/school-applications/me`, the
 * same posture as the refresh cookie (modules/auth/delivery.ts): scripts cannot read it, and no
 * cross-site request -- not even top-level navigation -- carries it. That is what lets the JSON
 * endpoints under that path skip the double-submit CSRF check (see middleware/csrf.ts).
 */

import { ERROR_CODES } from "@studafy/constants";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { decodeProtectedHeader, jwtVerify, SignJWT } from "jose";

import { CodedHttpException } from "../../coded-http-exception";
import { getSecurityConfig } from "../../config/security";

import type { AppEnv } from "../../middleware/requestId";
import type { KeyStore } from "../auth/jwt/key-store";
import type { Context } from "hono";

export type ApplicantProvider = "google" | "microsoft" | "mock";

export interface ApplicantIdentity {
  provider: ApplicantProvider;
  /** The IdP `sub` claim. */
  subject: string;
  /** Verified email from the id_token, lower-cased. */
  email: string;
  /** Display name from the id_token, when the provider supplied one. */
  name: string | null;
}

export interface ApplicantSessionConfig {
  keyStore: KeyStore;
  issuer: string;
  /** The access-token audience; the applicant audience is derived from it. */
  audience: string;
}

export const APPLICANT_COOKIE_NAME = "studafy_applicant";
export const APPLICANT_COOKIE_PATH = "/api/school-applications/me";
/** Long enough to fill the form and upload a scan; short enough that a shared computer forgets. */
export const APPLICANT_SESSION_TTL_SECONDS = 2 * 60 * 60;

const PROVIDERS: ReadonlySet<string> = new Set(["google", "microsoft", "mock"]);

function applicantAudience(config: ApplicantSessionConfig): string {
  return `${config.audience}:school-applicant`;
}

export async function signApplicantSession(
  config: ApplicantSessionConfig,
  identity: ApplicantIdentity,
): Promise<string> {
  const key = config.keyStore.signingKey();
  return new SignJWT({ provider: identity.provider, email: identity.email, name: identity.name })
    .setProtectedHeader({ alg: "RS256", kid: key.kid })
    .setSubject(identity.subject)
    .setIssuer(config.issuer)
    .setAudience(applicantAudience(config))
    .setIssuedAt()
    .setExpirationTime(`${APPLICANT_SESSION_TTL_SECONDS}s`)
    .sign(key.privateKey);
}

/** Verifies a presented applicant token, or returns null for anything invalid or expired. */
export async function verifyApplicantSession(
  config: ApplicantSessionConfig,
  token: string,
): Promise<ApplicantIdentity | null> {
  try {
    const { kid, alg } = decodeProtectedHeader(token);
    if (alg !== "RS256" || typeof kid !== "string") return null;
    const publicKey = await config.keyStore.publicKeyFor(kid);
    if (!publicKey) return null;

    const { payload } = await jwtVerify(token, publicKey, {
      issuer: config.issuer,
      audience: applicantAudience(config),
      algorithms: ["RS256"],
    });
    const { sub, provider, email, name } = payload;
    if (
      typeof sub !== "string" ||
      typeof provider !== "string" ||
      !PROVIDERS.has(provider) ||
      typeof email !== "string"
    ) {
      return null;
    }
    return {
      provider: provider as ApplicantProvider,
      subject: sub,
      email,
      name: typeof name === "string" ? name : null,
    };
  } catch {
    return null;
  }
}

function useSecureCookie(): boolean {
  const { environment } = getSecurityConfig();
  return environment !== "development" && environment !== "test";
}

export function setApplicantCookie(c: Context<AppEnv>, token: string): void {
  setCookie(c, APPLICANT_COOKIE_NAME, token, {
    httpOnly: true,
    secure: useSecureCookie(),
    sameSite: "Strict",
    path: APPLICANT_COOKIE_PATH,
    maxAge: APPLICANT_SESSION_TTL_SECONDS,
  });
}

export function clearApplicantCookie(c: Context<AppEnv>): void {
  deleteCookie(c, APPLICANT_COOKIE_NAME, {
    path: APPLICANT_COOKIE_PATH,
    secure: useSecureCookie(),
    sameSite: "Strict",
  });
}

/** The signed-in applicant, or 401 SCHOOL_APPLICATION_SESSION_REQUIRED. */
export async function requireApplicant(
  c: Context<AppEnv>,
  config: ApplicantSessionConfig,
): Promise<ApplicantIdentity> {
  const token = getCookie(c, APPLICANT_COOKIE_NAME);
  const identity = token ? await verifyApplicantSession(config, token) : null;
  if (!identity) {
    throw new CodedHttpException(
      401,
      ERROR_CODES.SCHOOL_APPLICATION_SESSION_REQUIRED,
      "Sign in with Google or Microsoft to continue your application.",
    );
  }
  return identity;
}
