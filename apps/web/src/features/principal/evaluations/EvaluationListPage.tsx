import { Button, Select, Table } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { useFormatters, useTranslation } from "../../../lib/i18n";

import { CreateEvaluationModal } from "./CreateEvaluationModal";
import {
  EVALUATION_RATING_LABEL_KEYS,
  EVALUATION_STATUS_LABEL_KEYS,
  EVALUATION_TYPE_LABEL_KEYS,
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

/** Status filter options as translation keys — resolved with `t(...)` at render time. */
const STATUS_OPTION_KEYS: { value: EvaluationStatus | typeof ALL_STATUSES; labelKey: string }[] = [
  { value: ALL_STATUSES, labelKey: "principal.evaluations.list.allStatuses" },
  { value: "draft", labelKey: EVALUATION_STATUS_LABEL_KEYS.draft },
  { value: "submitted", labelKey: EVALUATION_STATUS_LABEL_KEYS.submitted },
  { value: "finalized", labelKey: EVALUATION_STATUS_LABEL_KEYS.finalized },
];

/**
 * Teacher evaluation list (`/portal/principal/evaluations`). Filterable by status and teacher;
 * "New evaluation" starts a fresh cycle via `CreateEvaluationModal`, and "Manage criteria templates"
 * links to `CriteriaTemplatesPage`, where the scoring rubric `EvaluationDetailPage` reuses is
 * defined. A row's teacher name links to that evaluation's detail screen.
 */
export default function EvaluationListPage() {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
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

  const statusOptions: SelectOption<EvaluationStatus | typeof ALL_STATUSES>[] =
    STATUS_OPTION_KEYS.map(({ value, labelKey }) => ({ value, label: t(labelKey) }));

  const teacherOptions: SelectOption<string>[] = [
    { value: ALL_TEACHERS, label: t("principal.evaluations.list.allTeachers") },
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
          <h1>{t("principal.evaluations.list.title")}</h1>
          <p>{t("principal.evaluations.list.description")}</p>
        </div>
        <div className="evaluations-list__header-actions">
          <Link
            className="evaluations-list__templates-link"
            to="/portal/principal/evaluations/templates"
          >
            {t("principal.evaluations.list.manageTemplates")}
          </Link>
          <Button type="button" variant="primary" onClick={() => setCreateOpen(true)}>
            {t("principal.evaluations.list.newEvaluation")}
          </Button>
        </div>
      </div>

      <div className="evaluations-list__filters">
        <Select
          label={t("principal.evaluations.list.statusLabel")}
          options={statusOptions}
          value={statusFilter}
          onChange={setStatusFilter}
        />
        <Select
          label={t("principal.evaluations.list.teacherLabel")}
          options={teacherOptions}
          value={teacherFilter}
          onChange={setTeacherFilter}
        />
      </div>

      <Table caption={t("principal.evaluations.list.caption")}>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>{t("principal.evaluations.list.columns.teacher")}</Table.HeaderCell>
            <Table.HeaderCell>{t("principal.evaluations.list.columns.type")}</Table.HeaderCell>
            <Table.HeaderCell>{t("principal.evaluations.list.columns.status")}</Table.HeaderCell>
            <Table.HeaderCell>{t("principal.evaluations.list.columns.rating")}</Table.HeaderCell>
            <Table.HeaderCell>{t("principal.evaluations.list.columns.shared")}</Table.HeaderCell>
            <Table.HeaderCell>
              {t("principal.evaluations.list.columns.evaluatedAt")}
            </Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body
          columnCount={COLUMN_COUNT}
          loading={evaluationsQuery.isPending}
          empty={
            evaluationsQuery.isError
              ? t("principal.evaluations.list.error")
              : t("principal.evaluations.list.empty")
          }
        >
          {evaluations.map((evaluation) => (
            <Table.Row key={evaluation.id}>
              <Table.Cell>
                <Link to={`/portal/principal/evaluations/${evaluation.id}`}>
                  {teacherNameById.get(evaluation.teacher_id) ?? evaluation.teacher_id}
                </Link>
              </Table.Cell>
              <Table.Cell>{t(EVALUATION_TYPE_LABEL_KEYS[evaluation.evaluation_type])}</Table.Cell>
              <Table.Cell>{t(EVALUATION_STATUS_LABEL_KEYS[evaluation.status])}</Table.Cell>
              <Table.Cell>
                {evaluation.rating ? t(EVALUATION_RATING_LABEL_KEYS[evaluation.rating]) : "—"}
              </Table.Cell>
              <Table.Cell>
                {evaluation.shared_with_teacher
                  ? t("principal.evaluations.list.shared")
                  : t("principal.evaluations.list.notShared")}
              </Table.Cell>
              <Table.Cell>{formatDate(new Date(evaluation.evaluated_at))}</Table.Cell>
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
