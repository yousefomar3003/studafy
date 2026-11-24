import { Button, Checkbox, Modal, Select, Table, useToast } from "@studafy/ui";
import { useState } from "react";

import { useFormatters, useTranslation } from "../../../lib/i18n";
import { useSubjects } from "../school/queries";
import { useGradeLevels } from "../sections/queries";

import { Badge, DateTime, Percent, QueryState, TextArea } from "./components";
import { problemMessage } from "./errors";
import {
  useAddRemedialNote,
  useRemedialPlan,
  useRemedialPlans,
  useRemedialSettings,
  useUpdateRemedialSettings,
} from "./remedial-plans";

import type { BadgeTone } from "./components";
import type { SetupContext } from "./context";
import type { RemedialPlan, RemedialPlanStatus, RemedialPlanSummary } from "./remedial-plans";

const ALL = "all";
const STATUSES: readonly RemedialPlanStatus[] = ["open", "in_progress", "achieved", "closed"];
const STATUS_TONE: Record<RemedialPlanStatus, BadgeTone> = {
  open: "info",
  in_progress: "warning",
  achieved: "success",
  closed: "neutral",
};

/** An unknown status (a newer server) reads as closed rather than breaking the screen. */
function statusOf(value: string): RemedialPlanStatus {
  return (STATUSES as readonly string[]).includes(value) ? (value as RemedialPlanStatus) : "closed";
}

/** A `YYYY-MM-DD` value as a local calendar date, so no time zone can move it a day. */
function parseIsoDate(value: string): Date {
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  return new Date(year!, month! - 1, day!);
}

function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation();
  const known = statusOf(status);
  // eslint-disable-next-line security/detect-object-injection -- `known` is the closed status union
  return <Badge tone={STATUS_TONE[known]}>{t(`academicGrading.remedial.status.${known}`)}</Badge>;
}

function ReviewDate({ value, overdue }: { value: string | null; overdue: boolean }) {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  if (!value) return <>—</>;
  return (
    <>
      {formatDate(parseIsoDate(value), { dateStyle: "medium" })}{" "}
      {overdue ? <Badge tone="danger">{t("academicGrading.remedial.overdue")}</Badge> : null}
    </>
  );
}

/**
 * Remedial plans for the selected year (000269). Teachers open and update plans in the mobile app;
 * leadership follows them up here: the counts, the plans by grade, subject, status or overdue
 * review, each plan's targets, reviews and timeline, and follow-up notes. Leadership with
 * academicConfig:manage also decides whether teachers may share plans with students and parents.
 */
export function RemedialPlansTab({ ctx }: { ctx: SetupContext }) {
  const { t } = useTranslation();
  const grades = useGradeLevels();
  const subjects = useSubjects();
  const [gradeLevelId, setGradeLevelId] = useState<string>(ALL);
  const [subjectId, setSubjectId] = useState<string>(ALL);
  const [status, setStatus] = useState<string>(ALL);
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [openPlanId, setOpenPlanId] = useState<string | null>(null);
  const plans = useRemedialPlans(ctx.year.id, {
    gradeLevelId: gradeLevelId === ALL ? undefined : gradeLevelId,
    subjectId: subjectId === ALL ? undefined : subjectId,
    status: status === ALL ? undefined : statusOf(status),
    overdueOnly,
  });
  const counts = plans.data?.counts;

  return (
    <section className="ag-block" aria-labelledby="ag-remedial-heading">
      <h2 id="ag-remedial-heading">{t("academicGrading.remedial.heading")}</h2>
      <p className="ag-muted">{t("academicGrading.remedial.help", { year: ctx.year.name })}</p>
      <SharingSetting canManage={ctx.can.manage} />
      {counts ? (
        <ul
          className="ag-checks ag-remedial-counts"
          aria-label={t("academicGrading.remedial.countsLabel")}
        >
          {STATUSES.map((key) => (
            <li key={key}>
              <StatusBadge status={key} />{" "}
              {/* eslint-disable-next-line security/detect-object-injection -- closed status union */}
              <strong>{counts[key]}</strong>
            </li>
          ))}
          <li>
            <Badge tone="danger">{t("academicGrading.remedial.overdueReviews")}</Badge>{" "}
            <strong>{counts.overdue}</strong>
          </li>
        </ul>
      ) : null}
      <div className="principal-school__filters">
        <Select
          label={t("academicGrading.remedial.filters.grade")}
          options={[
            { value: ALL, label: t("academicGrading.remedial.filters.allGrades") },
            ...(grades.data ?? []).map((grade) => ({ value: grade.id, label: grade.name })),
          ]}
          value={gradeLevelId}
          onChange={setGradeLevelId}
        />
        <Select
          label={t("academicGrading.remedial.filters.subject")}
          options={[
            { value: ALL, label: t("academicGrading.remedial.filters.allSubjects") },
            ...(subjects.data ?? []).map((subject) => ({ value: subject.id, label: subject.name })),
          ]}
          value={subjectId}
          onChange={setSubjectId}
        />
        <Select
          label={t("academicGrading.remedial.filters.status")}
          options={[
            { value: ALL, label: t("academicGrading.remedial.filters.allStatuses") },
            ...STATUSES.map((key) => ({
              value: key,
              label: t(`academicGrading.remedial.status.${key}`),
            })),
          ]}
          value={status}
          onChange={setStatus}
        />
        <Checkbox
          label={t("academicGrading.remedial.filters.overdueOnly")}
          checked={overdueOnly}
          onChange={(event) => setOverdueOnly(event.target.checked)}
        />
      </div>
      <PlansTable
        plans={plans.data?.plans ?? []}
        loading={plans.isPending}
        error={plans.isError ? problemMessage(plans.error, t) : null}
        onOpen={setOpenPlanId}
      />
      {plans.data?.truncated ? (
        <p className="ag-notice">{t("academicGrading.remedial.truncated")}</p>
      ) : null}
      {openPlanId ? <PlanModal planId={openPlanId} onClose={() => setOpenPlanId(null)} /> : null}
    </section>
  );
}

function SharingSetting({ canManage }: { canManage: boolean }) {
  const { t } = useTranslation();
  const { show } = useToast();
  const settings = useRemedialSettings();
  const update = useUpdateRemedialSettings();
  if (!settings.data) return null;
  return (
    <div className="ag-card ag-block">
      <Checkbox
        label={t("academicGrading.remedial.sharing.label")}
        checked={settings.data.family_visible}
        disabled={!canManage || update.isPending}
        onChange={(event) =>
          update.mutate(event.target.checked, {
            onSuccess: () =>
              show({ variant: "success", title: t("academicGrading.remedial.sharing.saved") }),
            onError: (error) =>
              show({
                variant: "error",
                title: t("academicGrading.remedial.sharing.failed"),
                description: problemMessage(error, t),
              }),
          })
        }
      />
      <p className="ag-muted">{t("academicGrading.remedial.sharing.help")}</p>
    </div>
  );
}

function PlansTable({
  plans,
  loading,
  error,
  onOpen,
}: {
  plans: readonly RemedialPlanSummary[];
  loading: boolean;
  error: string | null;
  onOpen: (planId: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <Table caption={t("academicGrading.remedial.caption")} hideCaption>
      <Table.Header>
        <Table.Row>
          <Table.HeaderCell>{t("academicGrading.remedial.columns.student")}</Table.HeaderCell>
          <Table.HeaderCell>{t("academicGrading.remedial.columns.class")}</Table.HeaderCell>
          <Table.HeaderCell>{t("academicGrading.remedial.columns.subject")}</Table.HeaderCell>
          <Table.HeaderCell>{t("academicGrading.remedial.columns.status")}</Table.HeaderCell>
          <Table.HeaderCell>{t("academicGrading.remedial.columns.nextReview")}</Table.HeaderCell>
          <Table.HeaderCell>{t("academicGrading.remedial.columns.lastNote")}</Table.HeaderCell>
          <Table.HeaderCell>{t("academicGrading.remedial.columns.actions")}</Table.HeaderCell>
        </Table.Row>
      </Table.Header>
      <Table.Body
        columnCount={7}
        loading={loading}
        empty={error ?? t("academicGrading.remedial.empty")}
      >
        {plans.map((plan) => {
          const student = `${plan.student_first_name} ${plan.student_last_name}`;
          return (
            <Table.Row key={plan.id}>
              <Table.Cell>
                {student}
                <div className="ag-muted">{plan.admission_number}</div>
              </Table.Cell>
              <Table.Cell>
                {plan.grade_level_name} – {plan.section_name}
              </Table.Cell>
              <Table.Cell>
                {plan.subject_name}
                <div className="ag-muted">
                  {plan.term_name ?? t("academicGrading.remedial.wholeYear")}
                </div>
              </Table.Cell>
              <Table.Cell>
                <StatusBadge status={plan.status} />
              </Table.Cell>
              <Table.Cell>
                <ReviewDate value={plan.next_review_on} overdue={plan.overdue} />
              </Table.Cell>
              <Table.Cell>
                <DateTime value={plan.last_note_at} />
              </Table.Cell>
              <Table.Cell>
                <Button
                  type="button"
                  variant="secondary"
                  aria-label={t("academicGrading.remedial.openLabel", {
                    student,
                    subject: plan.subject_name,
                  })}
                  onClick={() => onOpen(plan.id)}
                >
                  {t("academicGrading.common.view")}
                </Button>
              </Table.Cell>
            </Table.Row>
          );
        })}
      </Table.Body>
    </Table>
  );
}

/** One plan: what it targets, its reviews and timeline, and a follow-up note. */
function PlanModal({ planId, onClose }: { planId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const plan = useRemedialPlan(planId);
  const title = plan.data
    ? t("academicGrading.remedial.planTitle", {
        student: `${plan.data.student_first_name} ${plan.data.student_last_name}`,
        subject: plan.data.subject_name,
      })
    : t("academicGrading.common.loading");
  return (
    <Modal open onClose={onClose} title={title}>
      <Modal.Body>
        <QueryState isPending={plan.isPending} error={plan.error}>
          {plan.data ? <PlanDetail plan={plan.data} /> : null}
        </QueryState>
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={onClose}>
          {t("academicGrading.common.done")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

function PlanDetail({ plan }: { plan: RemedialPlan }) {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const reason = plan.reason === "below_pass" ? "below_pass" : "teacher_concern";
  return (
    <>
      <p>
        <StatusBadge status={plan.status} />{" "}
        {plan.shared_with_family ? (
          <Badge tone="info">{t("academicGrading.remedial.shared")}</Badge>
        ) : (
          <Badge tone="neutral">{t("academicGrading.remedial.staffOnly")}</Badge>
        )}
      </p>
      <dl className="ag-grid ag-grid--dense">
        <div>
          <dt>{t("academicGrading.remedial.fields.period")}</dt>
          <dd>{plan.term_name ?? t("academicGrading.remedial.wholeYear")}</dd>
        </div>
        <div>
          <dt>{t("academicGrading.remedial.fields.reason")}</dt>
          <dd>
            {t(`academicGrading.remedial.reason.${reason}`)}
            {plan.reason_note ? <div className="ag-muted">{plan.reason_note}</div> : null}
          </dd>
        </div>
        <div>
          <dt>{t("academicGrading.remedial.fields.startPercentage")}</dt>
          <dd>
            <Percent value={plan.start_percentage} /> (
            {t("academicGrading.remedial.fields.passLine")} <Percent value={plan.pass_percentage} />
            )
          </dd>
        </div>
        <div>
          <dt>{t("academicGrading.remedial.fields.openedBy")}</dt>
          <dd>
            {plan.created_by_name ?? "—"} · <DateTime value={plan.created_at} />
          </dd>
        </div>
      </dl>
      <h3 className="ag-subheading">{t("academicGrading.remedial.fields.targets")}</h3>
      <p className="ag-prewrap">{plan.targets}</p>
      <h3 className="ag-subheading">{t("academicGrading.remedial.fields.actions")}</h3>
      <p className="ag-prewrap">{plan.actions}</p>
      <h3 className="ag-subheading">{t("academicGrading.remedial.fields.reviews")}</h3>
      {plan.reviews.length === 0 ? (
        <p className="ag-muted">{t("academicGrading.remedial.noReviews")}</p>
      ) : (
        <ul>
          {plan.reviews.map((review) => (
            <li key={review.review_on}>
              <ReviewDate value={review.review_on} overdue={review.overdue} />{" "}
              {review.completed_at ? (
                <Badge tone="success">{t("academicGrading.remedial.reviewDone")}</Badge>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <h3 className="ag-subheading">{t("academicGrading.remedial.fields.timeline")}</h3>
      {plan.notes.length === 0 ? (
        <p className="ag-muted">{t("academicGrading.remedial.noNotes")}</p>
      ) : (
        <ol className="ag-timeline">
          {plan.notes.map((note) => (
            <li key={note.id}>
              <div className="ag-muted">
                {note.author_name ?? "—"} ·{" "}
                {t(`academicGrading.remedial.author.${note.author_access}`)} ·{" "}
                {formatDate(new Date(note.created_at), { dateStyle: "medium", timeStyle: "short" })}
                {note.internal ? (
                  <>
                    {" "}
                    <Badge tone="neutral">{t("academicGrading.remedial.internal")}</Badge>
                  </>
                ) : null}
              </div>
              {note.kind === "status_change" ? (
                <p>
                  {t("academicGrading.remedial.statusChanged")}{" "}
                  <StatusBadge status={note.new_status ?? ""} />
                </p>
              ) : null}
              {note.body ? <p className="ag-prewrap">{note.body}</p> : null}
            </li>
          ))}
        </ol>
      )}
      {plan.can_add_note ? <NoteForm planId={plan.id} /> : null}
    </>
  );
}

function NoteForm({ planId }: { planId: string }) {
  const { t } = useTranslation();
  const { show } = useToast();
  const add = useAddRemedialNote();
  const [body, setBody] = useState("");
  const [internal, setInternal] = useState(false);
  return (
    <form
      className="ag-card ag-block"
      onSubmit={(event) => {
        event.preventDefault();
        if (!body.trim()) return;
        add.mutate(
          { planId, body: body.trim(), internal },
          {
            onSuccess: () => {
              setBody("");
              show({ variant: "success", title: t("academicGrading.remedial.noteAdded") });
            },
          },
        );
      }}
    >
      <TextArea
        label={t("academicGrading.remedial.noteLabel")}
        value={body}
        onChange={setBody}
        required
      />
      <Checkbox
        label={t("academicGrading.remedial.internalLabel")}
        checked={internal}
        onChange={(event) => setInternal(event.target.checked)}
      />
      {add.error ? (
        <p className="ag-error" role="alert">
          {problemMessage(add.error, t)}
        </p>
      ) : null}
      <Button type="submit" loading={add.isPending} disabled={!body.trim()}>
        {t("academicGrading.remedial.addNote")}
      </Button>
    </form>
  );
}
