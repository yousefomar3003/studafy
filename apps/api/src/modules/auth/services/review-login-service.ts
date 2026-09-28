/**
 * Review-only email/password login for the App Store / Play reviewer demo tenant (ST-303).
 *
 * Every real account signs in through an external OAuth provider. Apple and Google reviewers cannot
 * be expected to hold a Microsoft or Google account the school invited, so exactly one tenant -- the
 * school flagged `is_review_tenant` (migration 000116) -- carries identities under the `review`
 * provider, whose subject is the account's normalized email. This module authenticates those
 * identities, and only those, with one shared password held in the deployment's secret manager
 * (`REVIEW_LOGIN_PASSWORD`).
 *
 * The flow:
 *   1. Compare the presented password to the configured one in constant time.
 *   2. Resolve (`review`, email) through the existing login resolver (migration 000034) and confirm
 *      the identity's school is the review tenant.
 *   3. Any failure in 1 or 2 is one indistinguishable INVALID_CREDENTIALS outcome.
 *   4. Otherwise delegate to loginReturningUser, which re-applies the tenant suspension policy,
 *      updates last_login_at, writes the audit row, and issues the session token pair -- the same
 *      post-authentication path every OAuth login takes.
 *
 * Steps 1 and 2 both always run, so a wrong password and an unknown email cost the same work.
 */

import { createHash, timingSafeEqual } from "node:crypto";

import { findOAuthIdentity, loginReturningUser } from "./returning-user-login-service";

import type {
  ReturningUserLoginParams,
  ReturningUserLoginResult,
} from "./returning-user-login-service";
import type { SessionTokenConfig } from "./session-service";
import type { Database } from "../../../db/client";

/** The oauth_identities.provider value for reviewer accounts. Mirrored by db/seeds/review-tenant.ts. */
export const REVIEW_LOGIN_PROVIDER = "review";

export interface ReviewLoginParams extends Omit<ReturningUserLoginParams, "subject" | "provider"> {
  email: string;
  password: string;
  /** The configured `REVIEW_LOGIN_PASSWORD`. */
  expectedPassword: string;
}

export type ReviewLoginResult = ReturningUserLoginResult | { outcome: "INVALID_CREDENTIALS" };

/** Canonical form of a reviewer email, matching how the seed writes the identity subject. */
export function normalizeReviewEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Constant-time password comparison. Both sides are hashed first so the comparison runs over equal
 * lengths and leaks neither the configured password's length nor a matching prefix.
 */
function passwordMatches(presented: string, expected: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(presented), digest(expected));
}

/** True when (`review`, subject) resolves to an identity in the school flagged is_review_tenant. */
async function isReviewTenantIdentity(db: Database, subject: string): Promise<boolean> {
  const identity = await findOAuthIdentity(db, REVIEW_LOGIN_PROVIDER, subject);
  if (!identity) return false;

  // app.schools is a global table without RLS; the tenant scope is not needed to read the flag.
  let isReviewTenant = false;
  await db.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_app");
    const [school] = await tx<{ is_review_tenant: boolean }[]>`
      SELECT is_review_tenant FROM app.schools WHERE id = ${identity.schoolId}::uuid
    `;
    isReviewTenant = school?.is_review_tenant === true;
  });
  return isReviewTenant;
}

export async function loginReviewUser(
  db: Database,
  config: SessionTokenConfig,
  params: ReviewLoginParams,
): Promise<ReviewLoginResult> {
  const { email, password, expectedPassword, ...rest } = params;
  const subject = normalizeReviewEmail(email);

  const passwordOk = passwordMatches(password, expectedPassword);
  const identityOk = await isReviewTenantIdentity(db, subject);

  if (!passwordOk || !identityOk) {
    params.logger?.warn(
      { provider: REVIEW_LOGIN_PROVIDER, client_ip: params.clientIp, user_agent: params.userAgent },
      "review login failed: invalid credentials",
    );
    return { outcome: "INVALID_CREDENTIALS" };
  }

  return loginReturningUser(db, config, { ...rest, subject, provider: REVIEW_LOGIN_PROVIDER });
}
