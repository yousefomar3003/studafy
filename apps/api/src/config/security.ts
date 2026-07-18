/**
 * Security configuration: environment-aware CORS, CSRF, and security headers.
 *
 * This module provides the single source of truth for security policy across
 * development, staging, and production environments.
 *
 * The CORS allowlist is data (CORS_ALLOWED_ORIGINS), not a table compiled into this file. An
 * earlier revision hardcoded a per-environment map and it had already drifted from the
 * infrastructure that provisions the hosts: it listed studafy.com and www.studafy.com while
 * infra/terraform/environments/prod/prod.tfvars provisions app.studafy.com. A map here can only
 * ever be a second copy of a fact Terraform already owns, so it is deliberately not one.
 */

import { loadEnv, parseOriginList } from "../env";

export interface SecurityConfig {
  environment: "development" | "test" | "staging" | "production";
  allowedOrigins: string[];
  csrfCookieName: string;
  csrfHeaderName: string;
  sessionCookieName: string;
  csrfTokenSize: number;
  csrfCookieMaxAge: number;
  hstsMaxAge: number;
  cspReportOnly: boolean;
}

const CSRF_COOKIE_NAME = "XSRF-TOKEN";
const CSRF_HEADER_NAME = "X-XSRF-TOKEN";
const SESSION_COOKIE_NAME = "session";
const CSRF_TOKEN_SIZE = 32; // 256 bits
const CSRF_COOKIE_MAX_AGE = 86400; // 24 hours
const HSTS_MAX_AGE = 63072000; // 2 years

/**
 * Local-development fallback only. Never reachable in a deployed tier: envSchema's refinement
 * requires a non-empty CORS_ALLOWED_ORIGINS whenever APP_ENV is staging or production, so a
 * misconfigured deployment fails at bootstrap instead of silently landing on localhost.
 */
const LOCAL_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:3000",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:3000",
];

let cachedConfig: SecurityConfig | null = null;

export function getSecurityConfig(): SecurityConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const env = loadEnv();
  // NODE_ENV=test is its own arm so the test suite gets the local origins and a non-secure cookie
  // regardless of which deployment tier APP_ENV names.
  const environment: SecurityConfig["environment"] = env.NODE_ENV === "test" ? "test" : env.APP_ENV;

  const configuredOrigins = parseOriginList(env.CORS_ALLOWED_ORIGINS);
  const isLocal = environment === "development" || environment === "test";
  const allowedOrigins =
    configuredOrigins.length > 0 ? configuredOrigins : isLocal ? LOCAL_ORIGINS : [];

  cachedConfig = {
    environment,
    allowedOrigins,
    csrfCookieName: CSRF_COOKIE_NAME,
    csrfHeaderName: CSRF_HEADER_NAME,
    sessionCookieName: SESSION_COOKIE_NAME,
    csrfTokenSize: CSRF_TOKEN_SIZE,
    csrfCookieMaxAge: CSRF_COOKIE_MAX_AGE,
    hstsMaxAge: HSTS_MAX_AGE,
    cspReportOnly: environment === "development",
  };

  return cachedConfig;
}

export function resetSecurityConfig(): void {
  cachedConfig = null;
}
