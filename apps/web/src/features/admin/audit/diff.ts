export type AuditDiffStatus = "added" | "removed" | "changed";

export interface AuditDiffRow {
  key: string;
  before: unknown;
  after: unknown;
  status: AuditDiffStatus;
}

/** Structural equality good enough for audit snapshots: `old_values`/`new_values` are stored as
 * jsonb (see `apps/api/src/modules/audit/schemas.ts`), so a stringified comparison is exact and
 * avoids pulling in a deep-equal dependency for this one use. */
function valuesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Reduces a before/after audit snapshot to only the fields that were added, removed, or changed —
 * the unchanged majority of a typical row (id, unrelated columns) would just be noise in a diff
 * viewer. Redacted fields (the literal string `"[REDACTED]"`, applied server-side by
 * `redactPayload` in `apps/api/src/middleware/auditEmitter.ts`) pass through as plain strings;
 * there is nothing left to unmask client-side, so they diff exactly like any other value.
 */
export function buildAuditDiff(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): AuditDiffRow[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const rows: AuditDiffRow[] = [];

  for (const key of [...keys].sort()) {
    const hasBefore = before !== null && Object.hasOwn(before, key);
    const hasAfter = after !== null && Object.hasOwn(after, key);
    // `key` is drawn from `Object.keys` of these same objects and gated by `Object.hasOwn` above —
    // not attacker-controlled.
    // eslint-disable-next-line security/detect-object-injection
    const beforeValue = hasBefore ? before[key] : undefined;
    // eslint-disable-next-line security/detect-object-injection
    const afterValue = hasAfter ? after[key] : undefined;

    if (!hasBefore && hasAfter) {
      rows.push({ key, before: undefined, after: afterValue, status: "added" });
    } else if (hasBefore && !hasAfter) {
      rows.push({ key, before: beforeValue, after: undefined, status: "removed" });
    } else if (!valuesEqual(beforeValue, afterValue)) {
      rows.push({ key, before: beforeValue, after: afterValue, status: "changed" });
    }
  }

  return rows;
}

/** Renders a diff cell for display: a missing side reads as "—", primitives print as-is (including
 * `"[REDACTED]"`), and objects/arrays pretty-print as JSON. */
export function formatAuditValue(value: unknown): string {
  if (value === undefined || value === null) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value, null, 2);
}
