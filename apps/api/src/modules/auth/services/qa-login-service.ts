/**
 * Staging-only email/password login for the QA tenants (QA-02, docs/testing/qa-plan.md).
 *
 * Testers need a bearer token for every role, SUPER_ADMIN included, in more than one school, and
 * staging refuses the mock OAuth provider. The schools flagged `is_qa_tenant` (migration 000183)
 * carry identities under the `qa` provider, whose subject is the account's normalized email. This
 * module authenticates those identities, and only those, with one shared password held in the
 * deployment's secret manager (`QA_LOGIN_PASSWORD`). env.ts refuses to boot with that password set
 * when APP_ENV is production, so the route cannot exist where real schools live.
 *
 * The flow is the review login's (review-login-service.ts), against a different provider and flag:
 *   1. Compare the presented password to the configured one in constant time.
 *   2. Resolve (`qa`, email) through the existing login resolver and confirm the identity's school is
 *      a QA tenant.
 *   3. Any failure in 1 or 2 is one indistinguishable INVALID_CREDENTIALS outcome.
 *   4. Otherwise delegate to loginReturningUser -- suspension policy, last_login_at, audit row, and
 *      the session token pair, exactly as for an OAuth login.
 *
 * Steps 1 and 2 both always run, so a wrong password and an unknown email cost the same work.
 */

import { findOAuthIdentity, loginReturningUser } from "./returning-user-login-service";
import { normalizeReviewEmail, passwordMatches } from "./review-login-service";

import type {
  ReturningUserLoginParams,
  ReturningUserLoginResult,
} from "./returning-user-login-service";
import type { SessionTokenConfig } from "./session-service";
import type { Database } from "../../../db/client";

/** The oauth_identities.provider value for QA accounts. Mirrored by db/seeds/qa-credentials.ts. */
export const QA_LOGIN_PROVIDER = "qa";

export interface QaLoginParams extends Omit<ReturningUserLoginParams, "subject" | "provider"> {
  email: string;
  password: string;
  /** The configured `QA_LOGIN_PASSWORD`. */
  expectedPassword: string;
}

export type QaLoginResult = ReturningUserLoginResult | { outcome: "INVALID_CREDENTIALS" };

/** True when (`qa`, subject) resolves to an identity in a school flagged is_qa_tenant. */
async function isQaTenantIdentity(db: Database, subject: string): Promise<boolean> {
  const identity = await findOAuthIdentity(db, QA_LOGIN_PROVIDER, subject);
  if (!identity) return false;

  // app.schools is a global table without RLS; the tenant scope is not needed to read the flag.
  let isQaTenant = false;
  await db.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_app");
    const [school] = await tx<{ is_qa_tenant: boolean }[]>`
      SELECT is_qa_tenant FROM app.schools WHERE id = ${identity.schoolId}::uuid
    `;
    isQaTenant = school?.is_qa_tenant === true;
  });
  return isQaTenant;
}

export async function loginQaUser(
  db: Database,
  config: SessionTokenConfig,
  params: QaLoginParams,
): Promise<QaLoginResult> {
  const { email, password, expectedPassword, ...rest } = params;
  const subject = normalizeReviewEmail(email);

  const passwordOk = passwordMatches(password, expectedPassword);
  const identityOk = await isQaTenantIdentity(db, subject);

  if (!passwordOk || !identityOk) {
    params.logger?.warn(
      { provider: QA_LOGIN_PROVIDER, client_ip: params.clientIp, user_agent: params.userAgent },
      "qa login failed: invalid credentials",
    );
    return { outcome: "INVALID_CREDENTIALS" };
  }

  return loginReturningUser(db, config, { ...rest, subject, provider: QA_LOGIN_PROVIDER });
}
