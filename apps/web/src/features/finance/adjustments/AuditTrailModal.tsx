import { Modal } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";

import { api } from "../../../lib/api";
import { buildAuditDiff, formatAuditValue } from "../../admin/audit/diff";

import type { AuditLogEntry } from "../../admin/audit/queries";

export interface AuditTrailTarget {
  /** Present for a closed dialog too, so `AuditTrailModal` can be mounted unconditionally and just
   * toggle `open` — same idiom `AuditDiffModal`'s `entry: AuditLogEntry | null` uses. */
  targetTable: string;
  targetId: string;
  /** No audit entry for this record can predate its own creation — passed as the query's `from` so
   * the endpoint's own 30-day-ago default (see `auditLogQuerySchema`) never hides older history. */
  createdAt: string;
  /** For `award_cache`, every award in the school shares one `target_id` (the school id, not the
   * award's own id — see `createAward`'s `emitAuditLog` call in the API), so entries are matched by
   * this record's own id inside `old_values`/`new_values` instead of by `target_id`. `undefined`
   * skips that extra narrowing (refund entries carry the record's own id as `target_id` already). */
  recordId?: string;
}

export interface AuditTrailModalProps {
  target: AuditTrailTarget | null;
  onClose: () => void;
}

function actorLabel(entry: AuditLogEntry): string {
  return entry.actor_name ?? entry.actor_email ?? "System";
}

function carriesRecordId(values: Record<string, unknown> | null, recordId: string): boolean {
  if (!values) return false;
  return Object.values(values).includes(recordId);
}

/**
 * Read-only history for one award or refund record — the "audit trail visible on records"
 * acceptance criterion. Reuses `buildAuditDiff`/`formatAuditValue` from `admin/audit/diff` (pure
 * functions, no CSS dependency) rather than re-deriving the same before/after reduction; the modal
 * markup itself stays local to `adjustments.css` rather than pulling in `admin/audit`'s stylesheet,
 * matching this codebase's per-feature stylesheet convention (see `payments.css`'s doc comment).
 */
export function AuditTrailModal({ target, onClose }: AuditTrailModalProps) {
  const query = useQuery({
    queryKey: ["finance", "adjustments", "audit-trail", target?.targetTable, target?.targetId],
    queryFn: async () => {
      const { data } = await api.GET("/api/audit/logs", {
        params: {
          query: {
            target_table: target!.targetTable,
            target_id: target!.targetId,
            from: target!.createdAt,
            limit: 100,
          },
        },
      });
      return (data?.items ?? []) as AuditLogEntry[];
    },
    enabled: target !== null,
  });

  const entries = (query.data ?? []).filter((entry) => {
    if (!target?.recordId) return true;
    return (
      carriesRecordId(entry.old_values, target.recordId) ||
      carriesRecordId(entry.new_values, target.recordId)
    );
  });

  return (
    <Modal
      open={target !== null}
      onClose={onClose}
      title="Audit trail"
      description="Every recorded change to this record, oldest first."
    >
      <Modal.Body>
        {query.isPending ? (
          <p role="status">Loading…</p>
        ) : query.isError ? (
          <p role="alert">Couldn't load the audit trail.</p>
        ) : entries.length === 0 ? (
          <p>No audit entries recorded yet.</p>
        ) : (
          <ul className="adjustments-audit-trail">
            {[...entries].reverse().map((entry) => {
              const rows = buildAuditDiff(entry.old_values, entry.new_values);
              return (
                <li key={entry.id} className="adjustments-audit-trail__entry">
                  <p className="adjustments-audit-trail__meta">
                    <strong>{entry.action}</strong> by {actorLabel(entry)} &middot;{" "}
                    {new Date(entry.created_at).toLocaleString()}
                  </p>
                  {rows.length > 0 ? (
                    <ul className="adjustments-audit-trail__fields">
                      {rows.map((row) => (
                        <li key={row.key}>
                          <code>{row.key}</code>: {formatAuditValue(row.before)} &rarr;{" "}
                          {formatAuditValue(row.after)}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Modal.Body>
    </Modal>
  );
}
