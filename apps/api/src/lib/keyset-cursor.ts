import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../coded-http-exception";

/**
 * Keyset (cursor) pagination over a `(created_at, id)` pair ordered `DESC`.
 *
 * The cursor is an opaque base64url payload carrying the last row's `created_at` and `id`, so a
 * page boundary is a row, not a position: a notification inserted between two page fetches shifts
 * later pages by exactly one row instead of silently dropping or duplicating one (the failing
 * behavior of LIMIT/OFFSET under concurrent writes). The ordering key is stable because `id` is
 * immutable and `created_at` never changes once a row exists.
 *
 * Shared by every list route that pages `DESC` on `(created_at, id)` — `app.users` (ST-093) and
 * `app.notifications` (ST-142) — so the wire format has exactly one definition.
 *
 * Precision (QA-091): the cursor's `created_at` is a JS Date, so it holds milliseconds, while the
 * column holds microseconds. Comparing against it directly skips every row in the same millisecond
 * as the page's last row -- every row one transaction wrote shares `now()`, so a bulk import lost
 * all but its first page. Consumers therefore compare against the cursor row's *exact* value, read
 * back by primary key, and fall back to the cursor's value only if that row has since been deleted:
 *
 *   (t.created_at, t.id) < (
 *     COALESCE((SELECT k.created_at FROM app.<table> k WHERE k.id = $id), $created_at),
 *     $id
 *   )
 *
 * The wire format is unchanged, so cursors issued before the fix keep working.
 */

export interface KeysetCursor {
  created_at: string;
  id: string;
}

export function encodeKeysetCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ created_at: createdAt.toISOString(), id })).toString(
    "base64url",
  );
}

export function decodeKeysetCursor(cursor: string): KeysetCursor {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      typeof decoded !== "object" ||
      decoded === null ||
      typeof (decoded as KeysetCursor).created_at !== "string" ||
      typeof (decoded as KeysetCursor).id !== "string"
    ) {
      throw new Error("invalid cursor shape");
    }
    return decoded as KeysetCursor;
  } catch {
    throw new CodedHttpException(400, ERROR_CODES.VALIDATION_FAILED, "Invalid pagination cursor");
  }
}
