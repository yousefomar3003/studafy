import { Button, Select, Table } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { CreateEvaluationModal } from "./CreateEvaluationModal";
import {
  EVALUATION_RATING_LABELS,
  EVALUATION_STATUS_LABELS,
  EVALUATION_TYPE_LABELS,
} from "./labels";
import {
  evaluationListKey,
  fetchEvaluations,
  fetchTeacherContacts,
  TEACHER_CONTACTS_KEY,
} from "./queries";

import type { EvaluationStatus } from "./queries";
import type { SelectOption } from "@studafy/ui";

import "./evaluations.css";

const COLUMN_COUNT = 6;
const ALL_TEACHERS = "all";
const ALL_STATUSES = "all";

const STATUS_OPTIONS: SelectOption<EvaluationStatus | typeof ALL_STATUSES>[] = [
  { value: ALL_STATUSES, label: "All statuses" },
  { value: "draft", label: EVALUATION_STATUS_LABELS.draft },
  { value: "submitted", label: EVALUATION_STATUS_LABELS.submitted },
  { value: "finalized", label: EVALUATION_STATUS_LABELS.finalized },
];

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString();
}

/**
 * Teacher evaluation list (`/portal/principal/evaluations`). Filterable by status and teacher;
 * "New evaluation" starts a fresh cycle via `CreateEvaluationModal`, and "Manage criteria templates"
 * links to `CriteriaTemplatesPage`, where the scoring rubric `EvaluationDetailPage` reuses is
 * defined. A row's teacher name links to that evaluation's detail screen.
 */
export default function EvaluationListPage() {
  const [statusFilter, setStatusFilter] = useState<EvaluationStatus | typeof ALL_STATUSES>(
    ALL_STATUSES,
  );
  const [teacherFilter, setTeacherFilter] = useState<string>(ALL_TEACHERS);
  const [createOpen, setCreateOpen] = useState(false);

  const teachersQuery = useQuery({
    queryKey: TEACHER_CONTACTS_KEY,
    queryFn: fetchTeacherContacts,
  });

  const filter = {
    teacherId: teacherFilter === ALL_TEACHERS ? undefined : teacherFilter,
    status: statusFilter === ALL_STATUSES ? undefined : statusFilter,
  };

  const evaluationsQuery = useQuery({
    queryKey: evaluationListKey(filter),
    queryFn: () => fetchEvaluations(filter),
  });

  const teacherNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const teacher of teachersQuery.data ?? []) map.set(teacher.id, teacher.display_name);
    return map;
  }, [teachersQuery.data]);

  const teacherOptions: SelectOption<string>[] = [
    { value: ALL_TEACHERS, label: "All teachers" },
    ...(teachersQuery.data ?? []).map((teacher) => ({
      value: teacher.id,
      label: teacher.display_name,
    })),
  ];

  const evaluations = evaluationsQuery.data ?? [];

  return (
    <>
      <div className="evaluations-list__header">
        <div>
          <h1>Teacher evaluations</h1>
          <p>Evaluation cycles, criteria scoring, and sharing with teachers.</p>
        </div>
        <div className="evaluations-list__header-actions">
          <Link
            className="evaluations-list__templates-link"
            to="/portal/principal/evaluations/templates"
          >
            Manage criteria templates
          </Link>
          <Button type="button" variant="primary" onClick={() => setCreateOpen(true)}>
            New evaluation
          </Button>
        </div>
      </div>

      <div className="evaluations-list__filters">
        <Select
          label="Status"
          options={STATUS_OPTIONS}
          value={statusFilter}
          onChange={setStatusFilter}
        />
        <Select
          label="Teacher"
          options={teacherOptions}
          value={teacherFilter}
          onChange={setTeacherFilter}
        />
      </div>

      <Table caption="Teacher evaluations">
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>Teacher</Table.HeaderCell>
            <Table.HeaderCell>Type</Table.HeaderCell>
            <Table.HeaderCell>Status</Table.HeaderCell>
            <Table.HeaderCell>Rating</Table.HeaderCell>
            <Table.HeaderCell>Shared with teacher</Table.HeaderCell>
            <Table.HeaderCell>Evaluated at</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body
          columnCount={COLUMN_COUNT}
          loading={evaluationsQuery.isPending}
          empty={
            evaluationsQuery.isError
              ? "Unable to load evaluations."
              : "No evaluations match this filter."
          }
        >
          {evaluations.map((evaluation) => (
            <Table.Row key={evaluation.id}>
              <Table.Cell>
                <Link to={`/portal/principal/evaluations/${evaluation.id}`}>
                  {teacherNameById.get(evaluation.teacher_id) ?? evaluation.teacher_id}
                </Link>
              </Table.Cell>
              <Table.Cell>{EVALUATION_TYPE_LABELS[evaluation.evaluation_type]}</Table.Cell>
              <Table.Cell>{EVALUATION_STATUS_LABELS[evaluation.status]}</Table.Cell>
              <Table.Cell>
                {evaluation.rating ? EVALUATION_RATING_LABELS[evaluation.rating] : "—"}
              </Table.Cell>
              <Table.Cell>{evaluation.shared_with_teacher ? "Shared" : "Not shared"}</Table.Cell>
              <Table.Cell>{formatDate(evaluation.evaluated_at)}</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>

      <CreateEvaluationModal
        open={createOpen}
        teachers={teachersQuery.data ?? []}
        onClose={() => setCreateOpen(false)}
      />
    </>
  );
}
