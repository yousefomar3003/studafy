import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { withTenantTx } from "../../../db/tenant-tx";
import { requireAuth } from "../../../middleware/authContext";
import { getLocalizedMessage } from "../../../middleware/locale";
import { isAiModelCallPath } from "../consent/disclosure";
import { findCurrentConsent } from "../consent/persistence";

import { rememberConsentVerdict } from "./consent-gate";

import type { Database } from "../../../db/client";
import type { SupportedLocale } from "../../../middleware/locale";
import type { AppEnv } from "../../../middleware/requestId";
import type { MiddlewareHandler } from "hono";
import type { TransactionSql } from "postgres";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether `studentId` is the student record of `userId` in the transaction's school.
 *
 * `{studentId}` on the AI routes is an `app.students` id (the AI add-on, conversations, quizzes and
 * reports are all keyed by it), never the user id; `app.student_user_id` maps it back to its user.
 */
export async function isStudentSelf(
  tx: TransactionSql,
  studentId: string,
  userId: string,
): Promise<boolean> {
  const [row] = await tx<{ user_id: string | null }[]>`
    SELECT app.student_user_id(${studentId}::uuid)::text AS user_id
  `;
  return row?.user_id === userId;
}

/** How long a confirmed "this student record is this user" is trusted without a lookup. */
export const AI_STUDENT_SELF_CACHE_TTL_MS = 60_000;
const SELF_CACHE_MAX_ENTRIES = 10_000;

/**
 * Confirmed self verdicts, per API instance: `school:student:user` -> expiry. A student record's
 * user link is set at activation and practically never moves, so re-reading it on every AI request
 * (a transaction of its own) bought nothing. Only positive verdicts are kept, and only briefly:
 * a refusal is always re-checked, and a re-linked record is honoured within the TTL.
 */
const confirmedSelf = new Map<string, number>();

function selfCacheKey(schoolId: string, studentId: string, userId: string): string {
  return `${schoolId}:${studentId}:${userId}`;
}

function isCachedSelf(key: string, now: number): boolean {
  const expiresAt = confirmedSelf.get(key);
  if (expiresAt === undefined) return false;
  if (expiresAt > now) return true;
  confirmedSelf.delete(key);
  return false;
}

function cacheSelf(key: string, now: number): void {
  // Insertion order is age order: when full, drop the oldest entry.
  if (confirmedSelf.size >= SELF_CACHE_MAX_ENTRIES) {
    const oldest = confirmedSelf.keys().next().value;
    if (oldest !== undefined) confirmedSelf.delete(oldest);
  }
  confirmedSelf.set(key, now + AI_STUDENT_SELF_CACHE_TTL_MS);
}

/** Test seam: forget every cached verdict. */
export function clearAiStudentSelfCache(): void {
  confirmedSelf.clear();
}

/**
 * Self-only access for `/api/ai/students/{studentId}/*`.
 *
 * Every per-student AI route spends that student's AI add-on and reads or writes their AI history,
 * and tenant isolation alone only scopes them to the school. This refuses, with 403
 * AUTHZ_FORBIDDEN, any caller who is not the student in the path -- so another student, a parent or
 * a teacher in the same school cannot use or read a student's AI. Mounted ahead of the consent gate
 * and the feature gate, so a refused request reserves no quota.
 *
 * Cost: a confirmed verdict is cached briefly (above), and when the lookup does run on a route that
 * calls the model, the consent gate's lookup rides in the same transaction
 * (rememberConsentVerdict), so the two gates open at most one transaction per request.
 *
 * A malformed id passes through to the route's own validation (400), which never reaches a handler.
 */
export function aiStudentSelfGate(deps: { database: Database }): MiddlewareHandler<AppEnv> {
  const { database } = deps;

  return async (c, next) => {
    const studentId = c.req.param("studentId");
    if (!studentId || !UUID_PATTERN.test(studentId)) {
      await next();
      return;
    }

    const auth = requireAuth(c);
    const key = selfCacheKey(auth.schoolId, studentId, auth.userId);
    const now = Date.now();
    let self = isCachedSelf(key, now);
    if (!self) {
      const readConsent = isAiModelCallPath(c.req.path);
      self = await withTenantTx(
        database,
        { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") },
        async (tx) => {
          const isSelf = await isStudentSelf(tx, studentId, auth.userId);
          if (isSelf && readConsent) {
            rememberConsentVerdict(c.req.raw, (await findCurrentConsent(tx, auth.userId)) !== null);
          }
          return isSelf;
        },
      );
      if (self) cacheSelf(key, now);
    }

    if (!self) {
      throw new CodedHttpException(
        403,
        ERROR_CODES.AUTHZ_FORBIDDEN,
        getLocalizedMessage(
          ERROR_CODES.AUTHZ_FORBIDDEN,
          (c.get("locale") ?? "en") as SupportedLocale,
        ),
      );
    }

    await next();
  };
}
