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

import { useTranslation } from "../../../lib/i18n";

import { buildAuditDiff, formatAuditValue } from "./diff";
import { ACTION_LABEL_KEYS } from "./schema";

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
  const { t } = useTranslation();
  const rows = useMemo(
    () => (entry ? buildAuditDiff(entry.old_values, entry.new_values) : []),
    [entry],
  );

  return (
    <Modal
      open={entry !== null}
      onClose={onClose}
      title={t("adminSchool.audit.diff.title")}
      description={
        entry
          ? t("adminSchool.audit.diff.description", {
              action: t(ACTION_LABEL_KEYS[entry.action]),
              table: entry.target_table,
            })
          : undefined
      }
    >
      <Modal.Body>
        {rows.length === 0 ? (
          <p>{t("adminSchool.audit.diff.empty")}</p>
        ) : (
          <Table caption={t("adminSchool.audit.diff.caption")}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>{t("adminSchool.audit.diff.field")}</TableHeaderCell>
                <TableHeaderCell>{t("adminSchool.audit.diff.before")}</TableHeaderCell>
                <TableHeaderCell>{t("adminSchool.audit.diff.after")}</TableHeaderCell>
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
          {t("adminSchool.audit.diff.close")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
