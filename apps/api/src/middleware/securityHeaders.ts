/**
 * Security headers middleware: hardened HTTP response headers.
 *
 * Injects the following security headers on all responses:
 * - Content-Security-Policy (CSP)
 * - Strict-Transport-Security (HSTS)
 * - X-Frame-Options
 * - X-Content-Type-Options
 * - Referrer-Policy
 * - Permissions-Policy
 * - X-Permitted-Cross-Domain-Policies
 * - Cross-Origin-* headers
 *
 * @example
 * ```typescript
 * app.use("*", securityHeadersMiddleware());
 * ```
 */

import { getSecurityConfig } from "../config/security";

import type { MiddlewareHandler } from "hono";

export interface SecurityHeadersOptions {
  csp?: Partial<CspDirectives>;
  hsts?: Partial<HstsOptions>;
  reportOnly?: boolean;
  /** Paths that receive every header except CSP. See {@link CSP_EXEMPT_PATHS}. */
  cspExemptPaths?: string[];
}

/**
 * Paths served with no CSP.
 *
 * /docs is Scalar's API reference, which loads its bundle from a CDN (src/app.ts), so a
 * `script-src 'self'` policy blanks the page. The alternative — widening script-src globally to
 * admit the CDN — would weaken the policy on every real API route to accommodate one dev-only
 * page, so the exemption is scoped here instead. /docs is gated behind `docsEnabled` and is off
 * in production, and neither path renders attacker-controlled markup.
 */
const CSP_EXEMPT_PATHS = ["/docs", "/openapi.json"];

export interface CspDirectives {
  defaultSrc: string[];
  scriptSrc: string[];
  styleSrc: string[];
  imgSrc: string[];
  connectSrc: string[];
  fontSrc: string[];
  objectSrc: string[];
  mediaSrc: string[];
  frameSrc: string[];
  baseUri: string[];
  formAction: string[];
}

export interface HstsOptions {
  maxAge: number;
  includeSubDomains: boolean;
  preload: boolean;
}

const DEFAULT_CSP: CspDirectives = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'", "'unsafe-inline'"], // Required for Hono/Scalar
  imgSrc: ["'self'", "data:", "https:"],
  connectSrc: ["'self'"],
  fontSrc: ["'self'", "data:"],
  objectSrc: ["'none'"],
  mediaSrc: ["'self'"],
  frameSrc: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
};

const DEFAULT_HSTS: HstsOptions = {
  maxAge: 63072000, // 2 years
  includeSubDomains: true,
  preload: true,
};

/**
 * Build CSP header string from directives.
 */
function buildCspString(directives: CspDirectives): string {
  return Object.entries(directives)
    .map(([directive, values]) => {
      const directiveName = directive.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
      return `${directiveName} ${values.join(" ")}`;
    })
    .join("; ");
}

/**
 * Build HSTS header string.
 */
function buildHstsString(options: HstsOptions): string {
  let value = `max-age=${options.maxAge}`;
  if (options.includeSubDomains) {
    value += "; includeSubDomains";
  }
  if (options.preload) {
    value += "; preload";
  }
  return value;
}

/**
 * Security headers middleware factory.
 */
export function securityHeadersMiddleware(options?: SecurityHeadersOptions): MiddlewareHandler {
  const config = getSecurityConfig();
  const cspDirectives = { ...DEFAULT_CSP, ...options?.csp };
  const hstsOptions = { ...DEFAULT_HSTS, ...options?.hsts };
  const reportOnly = options?.reportOnly ?? config.cspReportOnly;
  const cspExemptPaths = options?.cspExemptPaths ?? CSP_EXEMPT_PATHS;

  // Pre-computed once at registration, not per request: these strings never vary, and building
  // them on the hot path is the kind of cost the ST-067 budget is spent on for nothing.
  const cspString = buildCspString(cspDirectives);
  const hstsString = buildHstsString(hstsOptions);
  const cspHeaderName = reportOnly
    ? "Content-Security-Policy-Report-Only"
    : "Content-Security-Policy";

  return async (c, next) => {
    await next();

    // Content-Security-Policy
    if (!cspExemptPaths.some((exempt) => c.req.path.startsWith(exempt))) {
      c.header(cspHeaderName, cspString);
    }

    // Strict-Transport-Security (HSTS)
    c.header("Strict-Transport-Security", hstsString);

    // X-Frame-Options: prevent clickjacking
    c.header("X-Frame-Options", "DENY");

    // X-Content-Type-Options: prevent MIME-type sniffing
    c.header("X-Content-Type-Options", "nosniff");

    // Referrer-Policy: control referrer information
    c.header("Referrer-Policy", "strict-origin-when-cross-origin");

    // Permissions-Policy: disable unnecessary browser features
    c.header(
      "Permissions-Policy",
      "geolocation=(), microphone=(), camera=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=()",
    );

    // X-Permitted-Cross-Domain-Policies: prevent Flash/PDF cross-domain attacks
    c.header("X-Permitted-Cross-Domain-Policies", "none");

    // Cross-Origin-Embedder-Policy is deliberately NOT set. `require-corp` buys cross-origin
    // isolation, which matters to a document that wants SharedArrayBuffer or precise timers — this
    // is a JSON API that owns no such document. What it does buy is a requirement that every
    // cross-origin subresource opt in via CORP, which breaks embedders for no gain here. COOP and
    // CORP below carry the isolation that is actually useful.

    // Cross-Origin-Opener-Policy
    c.header("Cross-Origin-Opener-Policy", "same-origin");

    // Cross-Origin-Resource-Policy
    c.header("Cross-Origin-Resource-Policy", "same-site");
  };
}
