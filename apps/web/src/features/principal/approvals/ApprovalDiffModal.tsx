import { Modal, Table } from "@studafy/ui";

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
  return (
    <Modal open={item !== null} onClose={onClose} title="What changed" description={item?.summary}>
      <Modal.Body>{item ? <DiffBody item={item} /> : null}</Modal.Body>
    </Modal>
  );
}

function DiffBody({ item }: { item: ApprovalQueueItem }) {
  if (item.item_type === "grade_submission") {
    const diff = item.diff as GradeSubmissionDiff;
    return (
      <>
        <dl className="approvals-diff__meta">
          <div>
            <dt>Class</dt>
            <dd>{diff.gradebook_class_code}</dd>
          </div>
          <div>
            <dt>Student</dt>
            <dd>{diff.student_name}</dd>
          </div>
        </dl>

        <Table caption={`Grades in this submission for ${diff.student_name}`}>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>Label</Table.HeaderCell>
              <Table.HeaderCell>Score</Table.HeaderCell>
              <Table.HeaderCell>Max score</Table.HeaderCell>
              <Table.HeaderCell>Weight</Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body columnCount={4} empty="No grade records in this submission.">
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
        <dt>Version</dt>
        <dd>{diff.version_name}</dd>
      </div>
      <div>
        <dt>Term</dt>
        <dd>{diff.term_name}</dd>
      </div>
      <div>
        <dt>Timetable slots</dt>
        <dd>{diff.slot_count}</dd>
      </div>
    </dl>
  );
}
