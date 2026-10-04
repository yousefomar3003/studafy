import { Modal, Table } from "@studafy/ui";

import { useTranslation } from "../../../lib/i18n";

import type { ApprovalQueueItem, GradeSubmissionDiff, TimetableVersionDiff } from "./queries";

export interface ApprovalDiffModalProps {
  item: ApprovalQueueItem | null;
  onClose: () => void;
}

/**
 * Read-only "what changed" view for one pending item — the diff view the unified queue needs
 * alongside approve/reject, kept in a modal rather than an inline table expansion (same choice
 * `UserSessionsPanel.tsx` and `BulkInviteProgressPanel.tsx` make for per-row detail).
 */
export function ApprovalDiffModal({ item, onClose }: ApprovalDiffModalProps) {
  const { t } = useTranslation();
  return (
    <Modal
      open={item !== null}
      onClose={onClose}
      title={t("principal.approvals.diff.title")}
      description={item?.summary}
    >
      <Modal.Body>{item ? <DiffBody item={item} /> : null}</Modal.Body>
    </Modal>
  );
}

function DiffBody({ item }: { item: ApprovalQueueItem }) {
  const { t } = useTranslation();
  if (item.item_type === "grade_submission") {
    const diff = item.diff as GradeSubmissionDiff;
    return (
      <>
        <dl className="approvals-diff__meta">
          <div>
            <dt>{t("principal.approvals.diff.class")}</dt>
            <dd>{diff.gradebook_class_code}</dd>
          </div>
          <div>
            <dt>{t("principal.approvals.diff.student")}</dt>
            <dd>{diff.student_name}</dd>
          </div>
        </dl>

        <Table
          caption={t("principal.approvals.diff.gradesCaption", { student: diff.student_name })}
        >
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>{t("principal.approvals.diff.label")}</Table.HeaderCell>
              <Table.HeaderCell>{t("principal.approvals.diff.score")}</Table.HeaderCell>
              <Table.HeaderCell>{t("principal.approvals.diff.maxScore")}</Table.HeaderCell>
              <Table.HeaderCell>{t("principal.approvals.diff.weight")}</Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body columnCount={4} empty={t("principal.approvals.diff.empty")}>
            {diff.grades.map((grade, index) => (
              <Table.Row key={index}>
                <Table.Cell>{grade.label}</Table.Cell>
                <Table.Cell>{grade.score ?? "—"}</Table.Cell>
                <Table.Cell>{grade.max_score}</Table.Cell>
                <Table.Cell>{grade.weight}</Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </>
    );
  }

  const diff = item.diff as TimetableVersionDiff;
  return (
    <dl className="approvals-diff__meta">
      <div>
        <dt>{t("principal.approvals.diff.version")}</dt>
        <dd>{diff.version_name}</dd>
      </div>
      <div>
        <dt>{t("principal.approvals.diff.term")}</dt>
        <dd>{diff.term_name}</dd>
      </div>
      <div>
        <dt>{t("principal.approvals.diff.slots")}</dt>
        <dd>{diff.slot_count}</dd>
      </div>
    </dl>
  );
}
