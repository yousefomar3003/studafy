import {
  Button,
  Modal,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "@studafy/ui";
import { useMemo } from "react";

import { buildAuditDiff, formatAuditValue } from "./diff";
import { ACTION_LABELS } from "./schema";

import type { AuditLogEntry } from "./queries";

export interface AuditDiffModalProps {
  /** `null` closes the modal — there is no separate `open` prop, so a closed modal can never point
   * at a stale entry. */
  entry: AuditLogEntry | null;
  onClose: () => void;
}

/**
 * Before/after viewer for one audit entry (ST-193's diff requirement). Renders only the fields that
 * actually changed — see `buildAuditDiff` — since most columns on a typical row (id, unrelated
 * fields) are unchanged noise in a diff. Redacted fields print their literal `"[REDACTED]"` marker
 * like any other string; the server already decided what this viewer is allowed to show.
 */
export function AuditDiffModal({ entry, onClose }: AuditDiffModalProps) {
  const rows = useMemo(
    () => (entry ? buildAuditDiff(entry.old_values, entry.new_values) : []),
    [entry],
  );

  return (
    <Modal
      open={entry !== null}
      onClose={onClose}
      title="Audit entry diff"
      description={entry ? `${ACTION_LABELS[entry.action]} · ${entry.target_table}` : undefined}
    >
      <Modal.Body>
        {rows.length === 0 ? (
          <p>No field-level changes recorded for this entry.</p>
        ) : (
          <Table caption="Before and after values">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Field</TableHeaderCell>
                <TableHeaderCell>Before</TableHeaderCell>
                <TableHeaderCell>After</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody columnCount={3}>
              {rows.map((row) => (
                <TableRow key={row.key}>
                  <TableCell>{row.key}</TableCell>
                  <TableCell>
                    <pre
                      className="audit-explorer__diff-value"
                      data-status={row.status === "added" ? "empty" : row.status}
                    >
                      {formatAuditValue(row.before)}
                    </pre>
                  </TableCell>
                  <TableCell>
                    <pre
                      className="audit-explorer__diff-value"
                      data-status={row.status === "removed" ? "empty" : row.status}
                    >
                      {formatAuditValue(row.after)}
                    </pre>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={onClose}>
          Close
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
