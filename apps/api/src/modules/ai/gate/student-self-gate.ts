import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { withTenantTx } from "../../../db/tenant-tx";
import { requireAuth } from "../../../middleware/authContext";
import { getLocalizedMessage } from "../../../middleware/locale";

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

/**
 * Self-only access for `/api/ai/students/{studentId}/*`.
 *
 * Every per-student AI route spends that student's AI add-on and reads or writes their AI history,
 * and tenant isolation alone only scopes them to the school. This refuses, with 403
 * AUTHZ_FORBIDDEN, any caller who is not the student in the path -- so another student, a parent or
 * a teacher in the same school cannot use or read a student's AI. Mounted ahead of the consent gate
 * and the feature gate, so a refused request reserves no quota.
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
    const self = await withTenantTx(
      database,
      { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") },
      (tx) => isStudentSelf(tx, studentId, auth.userId),
    );

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
