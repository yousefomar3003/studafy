/**
 * Account deletion requested from the public web page (ST-302) — Google Play's requirement that a
 * user can ask for deletion without the app and without signing in.
 *
 * Accounts sign in only through Google/Microsoft, so there is no password to check. Ownership is
 * proved by clicking a one-time link sent to the account's email address — the same proof the
 * invitation flow relies on to create the account in the first place.
 *
 * 1. requestAccountDeletion: captcha, then a per-address cooldown, then the address is resolved to
 *    its accounts across schools (normalized_email is unique only per school). If there are any, a
 *    256-bit token is stored in Redis — only its SHA-256, mapped to the address, for an hour — and
 *    the link is emailed through the outbox. The caller gets the same response whether or not the
 *    address has accounts, so the endpoint cannot be used to discover who uses Studafy.
 *
 * 2. confirmAccountDeletion: the token is looked up, the address is resolved again (the accounts
 *    may have changed in the hour), and each account goes through ST-301's deleteAccount — the same
 *    transaction, audit entry, erasure job and confirmation email as a deletion from account
 *    settings, with `source: "web_request"` on the audit entry. The token is deleted only after every
 *    account succeeded, so a failure part-way (a payment provider outage, say) can be retried from
 *    the same link; already-deleted accounts are archived and no longer resolve.
 *
 * Nothing is written to a school's audit log for an unconfirmed request: until the link is clicked
 * it is anonymous input, and auditing it would let anyone write rows into any school's audit log.
 */

import { DOMAIN_EVENTS, ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../coded-http-exception";
import { withTenantTx } from "../../db/tenant-tx";
import { normalizeAddress } from "../../email/ses-events";
import { emit } from "../../lib/events/emitter";
import { verifyCaptcha } from "../tenancy/registration/captcha";
import {
  generateToken,
  hashToken,
  VERIFICATION_TOKEN_PATTERN,
} from "../tenancy/verification/service";

import { deleteAccount } from "./account-deletion-service";

import type { AccountDeletionDeps } from "./account-deletion-service";
import type { Database } from "../../db/client";
import type { Logger } from "../../logger";
import type { RedisClient } from "../../redis";

export const DELETION_REQUEST_TTL_SECONDS = 60 * 60;
/** One email per address per window, however many times the form is submitted. */
export const DELETION_REQUEST_COOLDOWN_SECONDS = 5 * 60;

export interface DeletionRequestDeps extends AccountDeletionDeps {
  redis: RedisClient;
  /** Absent in development, where verifyCaptcha accepts any token. */
  captchaSecretKey: string | undefined;
}

export interface RequestAccountDeletionParams {
  email: string;
  captchaToken: string;
  clientIp?: string | null;
  requestId?: string;
  log?: Logger;
}

export interface ConfirmAccountDeletionParams {
  token: string;
  clientIp?: string | null;
  userAgent?: string | null;
  requestId?: string;
  log?: Logger;
}

export interface ConfirmedAccountDeletion {
  schoolName: string;
  requestId: string;
  completesBy: Date;
}

interface ResolvedAccount {
  userId: string;
  schoolId: string;
  schoolName: string;
  email: string;
}

const tokenKey = (token: string) =>
  `account-deletion-request:token:${hashToken(token).toString("hex")}`;
const cooldownKey = (normalizedEmail: string) =>
  `account-deletion-request:cooldown:${hashToken(normalizedEmail).toString("hex")}`;

export async function requestAccountDeletion(
  deps: DeletionRequestDeps,
  params: RequestAccountDeletionParams,
): Promise<void> {
  const captchaValid = await verifyCaptcha(
    params.captchaToken,
    deps.captchaSecretKey,
    params.clientIp ?? undefined,
  );
  if (!captchaValid) {
    throw new CodedHttpException(400, ERROR_CODES.CAPTCHA_INVALID, "Captcha verification failed.");
  }

  const email = normalizeAddress(params.email);
  const firstInWindow = await deps.redis.set(
    cooldownKey(email),
    "1",
    "EX",
    DELETION_REQUEST_COOLDOWN_SECONDS,
    "NX",
  );
  if (firstInWindow !== "OK") return;

  const accounts = await resolveAccounts(deps.database, email);
  const [first] = accounts;
  if (!first) {
    params.log?.info({ event: "account_deletion_request_no_account" }, "no account for address");
    return;
  }

  const token = generateToken();
  const expiresAt = new Date(Date.now() + DELETION_REQUEST_TTL_SECONDS * 1000);
  await deps.redis.set(tokenKey(token), email, "EX", DELETION_REQUEST_TTL_SECONDS);

  // The outbox is per school; the email goes out once, from the first account's school, and names
  // every school the link covers.
  await withTenantTx(
    deps.database,
    { schoolId: first.schoolId, requestId: params.requestId },
    (tx) =>
      emit(tx, DOMAIN_EVENTS.ACCOUNT_DELETION_REQUESTED, {
        email: first.email,
        expiresAt: expiresAt.toISOString(),
        schoolNames: [...new Set(accounts.map((a) => a.schoolName))],
        token,
      }),
  );
  params.log?.info(
    { event: "account_deletion_request_sent", accounts: accounts.length },
    "account deletion link sent",
  );
}

export async function confirmAccountDeletion(
  deps: DeletionRequestDeps,
  params: ConfirmAccountDeletionParams,
): Promise<ConfirmedAccountDeletion[]> {
  const key = VERIFICATION_TOKEN_PATTERN.test(params.token) ? tokenKey(params.token) : null;
  const email = key ? await deps.redis.get(key) : null;
  if (!key || !email) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.VERIFICATION_TOKEN_INVALID,
      "This deletion link is invalid or has expired. Request a new one.",
    );
  }

  const confirmed: ConfirmedAccountDeletion[] = [];
  for (const account of await resolveAccounts(deps.database, email)) {
    const result = await deleteAccount(deps, {
      schoolId: account.schoolId,
      userId: account.userId,
      source: "web_request",
      requestId: params.requestId,
      log: params.log,
      userAgent: params.userAgent,
      clientIp: params.clientIp,
    });
    confirmed.push({
      schoolName: account.schoolName,
      requestId: result.request.id,
      completesBy: result.request.slaDueAt,
    });
  }

  await deps.redis.del(key);
  return confirmed;
}

/** Every non-archived account registered under the address, across schools (migration 000115). */
async function resolveAccounts(database: Database, normalizedEmail: string) {
  let accounts: ResolvedAccount[] = [];
  await database.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_app");
    accounts = await tx<ResolvedAccount[]>`
      SELECT user_id AS "userId", school_id AS "schoolId", school_name AS "schoolName", email
      FROM app.resolve_accounts_for_deletion_request(${normalizedEmail})
    `;
  });
  return accounts;
}
