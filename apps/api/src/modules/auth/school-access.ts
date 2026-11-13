/**
 * Which schools may hold a session at all — the one place the school lifecycle meets authentication.
 *
 * Two rules, deliberately different in reach:
 *
 * - **Closed** (`archived`) is absolute. A school its administrator closed (POST
 *   /api/schools/current/closure) or the platform archived admits nobody: no sign-in, no refresh,
 *   no token issuance, and no request on a token minted before the closure. `archived` is terminal
 *   (see SCHOOL_TRANSITIONS in modules/platform/service.ts), so there is no way back to check for.
 * - **Suspended / pending** keep the long-standing login policy: standard roles are refused at
 *   sign-in, while SUPER_ADMIN and ORG_ADMIN may still sign in to resolve the issue. That policy
 *   is enforced at sign-in only, exactly as before.
 *
 * Every refusal surfaces as SCHOOL_SUSPENDED, the code clients already handle for "your school is
 * not available".
 */

import { ERROR_CODES, ROLES } from "@studafy/constants";

import { CodedHttpException } from "../../coded-http-exception";
import { withTenantTx } from "../../db/tenant-tx";

import type { Database, DatabasePools } from "../../db/client";
import type { Role } from "@studafy/constants";

/** The school status that means "closed": nobody may hold a session. */
export const CLOSED_SCHOOL_STATUS = "archived";

/** Roles permitted to sign in to a suspended (but not closed) school to resolve administrative issues. */
const ADMINISTRATIVE_ROLES: ReadonlySet<Role> = new Set([ROLES.SUPER_ADMIN, ROLES.ORG_ADMIN]);

/** Whether a school in this status is closed to every session, whatever the caller's role. */
export function isSchoolClosed(status: string | null | undefined): boolean {
  return status === CLOSED_SCHOOL_STATUS;
}

/**
 * The sign-in policy: active schools admit everyone, closed schools nobody, and any other status
 * only the administrative roles.
 */
export function isLoginPermitted(schoolStatus: string, roles: readonly Role[]): boolean {
  if (schoolStatus === "active") return true;
  if (isSchoolClosed(schoolStatus)) return false;
  return roles.some((role) => ADMINISTRATIVE_ROLES.has(role));
}

/** The client-facing refusal for a session in a closed school. 403, not 401: refreshing cannot fix it. */
export function schoolClosedException(): CodedHttpException {
  return new CodedHttpException(
    403,
    ERROR_CODES.SCHOOL_SUSPENDED,
    "This school has been closed and is no longer available.",
  );
}

/**
 * Reads a school's lifecycle status. The JWT middleware consults it only for a token that already
 * failed the entitlement-version check, so it costs nothing on the hot path.
 */
export interface SchoolStatusReader {
  /** The school's status, or `null` when the school does not exist. Must throw rather than guess. */
  status(schoolId: string): Promise<string | null>;
}

export function createSchoolStatusReader(database: Database | DatabasePools): SchoolStatusReader {
  return {
    async status(schoolId) {
      return withTenantTx(database, { schoolId }, async (tx) => {
        const [row] = await tx<{ status: string }[]>`
          SELECT status::text AS status FROM app.schools WHERE id = ${schoolId}::uuid
        `;
        return row?.status ?? null;
      });
    },
  };
}
