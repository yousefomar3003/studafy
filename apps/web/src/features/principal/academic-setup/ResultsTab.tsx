import { ERROR_CODES } from "@studafy/constants";
import { Button, Checkbox, Input, Select, Table, useToast } from "@studafy/ui";
import { useState } from "react";
import { Link } from "react-router-dom";

import { useFormatters, useTranslation } from "../../../lib/i18n";
import { useTerms } from "../school/queries";
import { sectionDisplayName, useSections } from "../sections/queries";

import {
  Badge,
  ConfirmModal,
  DateTime,
  Num,
  Percent,
  QueryState,
  ReasonModal,
  TextArea,
} from "./components";
import { setupHref } from "./context";
import { isProblem, problemMessage } from "./errors";
import {
  useCorrectResults,
  useFinalizeResults,
  useIssueCertificates,
  useReissueCertificate,
  useRevokeCertificate,
} from "./mutations";
import {
  useCertificateReadiness,
  useFinalizationCertificates,
  useFinalizationDetail,
  useFinalizations,
  useMarkSheet,
  useResultPreview,
} from "./queries";

import type { BadgeTone } from "./components";
import type { SetupContext } from "./context";
import type { CorrectResultsBody } from "./mutations";
import type {
  AcademicCertificate,
  CertificateReadinessStudent,
  ResultFinalizationDetail,
  ResultFinalizationSummary,
  ResultPreview,
} from "./queries";
import type { Term } from "../../admin/timetable/queries";

const ANNUAL = "annual";

const ACADEMIC_STATUS_TONE: Record<string, BadgeTone> = {
  promoted: "success",
  supplementary: "warning",
  retained: "danger",
  incomplete: "neutral",
};

const READINESS_TONE: Record<CertificateReadinessStudent["state"], BadgeTone> = {
  ready: "info",
  issued: "success",
  needs_reissue: "warning",
  blocked: "danger",
};

/**
 * Results for one section and period (a term, or the whole year): the preview of what finalizing
 * would store, finalizing it, the history of finalized versions (corrections create a new version
 * and keep the old one), and certificates or report cards for a finalized version.
 * Grades are never computed here — every figure is what the API returned.
 */
export function ResultsTab({ ctx }: { ctx: SetupContext }) {
  const { t } = useTranslation();
  const sections = useSections(ctx.year.id);
  const terms = useTerms(ctx.year.id);
  const [sectionId, setSectionId] = useState<string>();
  const [period, setPeriod] = useState<string>(ANNUAL);
  const list = [...(sections.data ?? [])].sort((a, b) =>
    sectionDisplayName(a, t).localeCompare(sectionDisplayName(b, t)),
  );
  const section = list.find((s) => s.id === sectionId) ?? list[0];
  const termList = [...(terms.data ?? [])].sort((a, b) => a.sequence_number - b.sequence_number);
  const termId = period === ANNUAL ? null : period;

  return (
    <QueryState
      isPending={sections.isPending || terms.isPending}
      error={sections.error ?? terms.error}
      empty={list.length === 0}
      emptyText={t("academicGrading.sections.noSections")}
    >
      <div className="principal-school__filters">
        <Select
          label={t("academicGrading.sections.sectionLabel")}
          options={list.map((s) => ({ value: s.id, label: sectionDisplayName(s, t) }))}
          value={section?.id}
          onChange={setSectionId}
        />
        <Select
          label={t("academicGrading.results.period")}
          options={[
            ...termList.map((term) => ({ value: term.id, label: term.name })),
            { value: ANNUAL, label: t("academicGrading.results.annual") },
          ]}
          value={period}
          onChange={setPeriod}
        />
      </div>
      {section ? (
        <SectionResults
          key={`${section.id}-${period}`}
          ctx={ctx}
          sectionId={section.id}
          sectionLabel={sectionDisplayName(section, t)}
          termId={termId}
          terms={termList}
        />
      ) : null}
    </QueryState>
  );
}

function SectionResults({
  ctx,
  sectionId,
  sectionLabel,
  termId,
  terms,
}: {
  ctx: SetupContext;
  sectionId: string;
  sectionLabel: string;
  termId: string | null;
  terms: Term[];
}) {
  const { t } = useTranslation();
  const finalizations = useFinalizations(ctx.year.id, sectionId);
  const periodName = (id: string | null) =>
    id === null
      ? t("academicGrading.results.annual")
      : (terms.find((term) => term.id === id)?.name ?? t("academicGrading.results.term"));
  const current = finalizations.data?.find(
    (row) => row.status === "finalized" && row.term_id === termId,
  );
  const [openId, setOpenId] = useState<string>();
  const openedId = openId ?? current?.id;

  return (
    <>
      {current ? (
        <p className="ag-notice ag-notice--info">
          {t("academicGrading.results.alreadyFinalized", {
            version: current.version,
            period: periodName(termId),
          })}
        </p>
      ) : (
        <PreviewPanel ctx={ctx} sectionId={sectionId} termId={termId} label={sectionLabel} />
      )}

      <section className="ag-block" aria-labelledby="ag-history-heading">
        <h2 id="ag-history-heading">{t("academicGrading.results.historyHeading")}</h2>
        <Table caption={t("academicGrading.results.historyCaption")} hideCaption>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>{t("academicGrading.results.columns.period")}</Table.HeaderCell>
              <Table.HeaderCell>{t("academicGrading.results.columns.version")}</Table.HeaderCell>
              <Table.HeaderCell>{t("academicGrading.results.columns.status")}</Table.HeaderCell>
              <Table.HeaderCell>
                {t("academicGrading.results.columns.finalizedAt")}
              </Table.HeaderCell>
              <Table.HeaderCell>{t("academicGrading.results.columns.correction")}</Table.HeaderCell>
              <Table.HeaderCell>{t("academicGrading.results.columns.actions")}</Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body
            columnCount={6}
            loading={finalizations.isPending}
            empty={
              finalizations.isError
                ? problemMessage(finalizations.error, t)
                : t("academicGrading.results.noHistory")
            }
          >
            {(finalizations.data ?? []).map((row) => (
              <Table.Row key={row.id}>
                <Table.Cell>{row.term_name ?? t("academicGrading.results.annual")}</Table.Cell>
                <Table.Cell>{t("academicGrading.results.versionN", { n: row.version })}</Table.Cell>
                <Table.Cell>
                  <Badge tone={row.status === "finalized" ? "success" : "neutral"}>
                    {t(`academicGrading.finalizationStatus.${row.status}`)}
                  </Badge>
                </Table.Cell>
                <Table.Cell>
                  <DateTime value={row.finalized_at} />
                </Table.Cell>
                <Table.Cell>{row.correction_reason ?? "—"}</Table.Cell>
                <Table.Cell>
                  <Button
                    type="button"
                    variant={row.id === openedId ? "secondary" : "tertiary"}
                    aria-label={t("academicGrading.results.openLabel", {
                      period: row.term_name ?? t("academicGrading.results.annual"),
                      n: row.version,
                    })}
                    aria-pressed={row.id === openedId}
                    onClick={() => setOpenId(row.id)}
                  >
                    {t("academicGrading.results.open")}
                  </Button>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </section>

      {openedId ? (
        <FinalizationPanel
          key={openedId}
          ctx={ctx}
          finalizationId={openedId}
          summary={finalizations.data?.find((row) => row.id === openedId)}
          sectionId={sectionId}
          onCorrected={setOpenId}
        />
      ) : null}
    </>
  );
}

function PreviewPanel({
  ctx,
  sectionId,
  termId,
  label,
}: {
  ctx: SetupContext;
  sectionId: string;
  termId: string | null;
  label: string;
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  const preview = useResultPreview(sectionId, termId);
  const finalize = useFinalizeResults();
  const [confirming, setConfirming] = useState(false);
  const [allowIncomplete, setAllowIncomplete] = useState(false);
  const incomplete = preview.data?.students.filter((s) => s.status === "incomplete") ?? [];
  const blockedBySheets = (preview.data?.unapproved_sheets.length ?? 0) > 0;
  const canFinalize =
    ctx.can.finalize && ctx.status === "active" && preview.data !== undefined && !blockedBySheets;

  function submit() {
    finalize.mutate(
      { sectionId, termId, allowIncomplete: incomplete.length > 0 && allowIncomplete },
      {
        onSuccess: () => {
          show({ variant: "success", title: t("academicGrading.results.finalized") });
          setConfirming(false);
        },
        onError: (error) => {
          show({
            variant: "error",
            title: t("academicGrading.results.finalizeFailed"),
            description: problemMessage(error, t),
          });
          if (!isProblem(error, ERROR_CODES.RESULTS_INCOMPLETE)) setConfirming(false);
        },
      },
    );
  }

  return (
    <section className="ag-block" aria-labelledby="ag-preview-heading">
      <div className="ag-head">
        <h2 id="ag-preview-heading">
          {t("academicGrading.results.previewHeading", { section: label })}
        </h2>
        {ctx.can.finalize ? (
          <Button type="button" disabled={!canFinalize} onClick={() => setConfirming(true)}>
            {t("academicGrading.results.finalize")}
          </Button>
        ) : null}
      </div>
      {ctx.status !== "active" ? (
        <p className="ag-notice">{t("academicGrading.results.notActive")}</p>
      ) : null}
      <QueryState isPending={preview.isPending} error={preview.error}>
        {preview.data ? (
          <>
            {blockedBySheets ? (
              <p className="ag-notice">
                {t("academicGrading.results.unapprovedSheets", {
                  sheets: preview.data.unapproved_sheets.join(", "),
                })}
              </p>
            ) : null}
            {incomplete.length > 0 ? (
              <p className="ag-notice">
                {t("academicGrading.results.incompleteCount", { count: incomplete.length })}
              </p>
            ) : preview.data.students.length > 0 ? (
              <p className="ag-notice ag-notice--success">
                {t("academicGrading.results.allComplete")}
              </p>
            ) : null}
            <StudentResultsTable students={preview.data.students} />
          </>
        ) : null}
      </QueryState>
      <ConfirmModal
        open={confirming}
        title={t("academicGrading.results.finalizeTitle", { section: label })}
        description={t("academicGrading.results.finalizeDescription")}
        confirmLabel={t("academicGrading.results.finalize")}
        submitting={finalize.isPending}
        confirmDisabled={incomplete.length > 0 && !allowIncomplete}
        onCancel={() => setConfirming(false)}
        onConfirm={submit}
      >
        {incomplete.length > 0 ? (
          <>
            <p className="ag-error">
              {t("academicGrading.results.incompleteWarning", { count: incomplete.length })}
            </p>
            <ul className="ag-list">
              {incomplete.map((student) => (
                <li key={student.student_id}>
                  {student.first_name} {student.last_name}
                </li>
              ))}
            </ul>
            <Checkbox
              label={t("academicGrading.results.allowIncomplete")}
              checked={allowIncomplete}
              onChange={(event) => setAllowIncomplete(event.target.checked)}
            />
          </>
        ) : (
          <p>{t("academicGrading.results.finalizeReady")}</p>
        )}
      </ConfirmModal>
    </section>
  );
}

type PreviewStudent = ResultPreview["students"][number];
type StoredStudent = ResultFinalizationDetail["results"][number];

function StudentResultsTable({
  students,
}: {
  students: readonly (PreviewStudent | StoredStudent)[];
}) {
  const { t } = useTranslation();
  return (
    <Table caption={t("academicGrading.results.studentsCaption")} hideCaption>
      <Table.Header>
        <Table.Row>
          <Table.HeaderCell>{t("academicGrading.results.columns.student")}</Table.HeaderCell>
          <Table.HeaderCell>{t("academicGrading.results.columns.completeness")}</Table.HeaderCell>
          <Table.HeaderCell>{t("academicGrading.results.columns.average")}</Table.HeaderCell>
          <Table.HeaderCell>{t("academicGrading.results.columns.total")}</Table.HeaderCell>
          <Table.HeaderCell>{t("academicGrading.results.columns.grade")}</Table.HeaderCell>
          <Table.HeaderCell>{t("academicGrading.results.columns.failed")}</Table.HeaderCell>
          <Table.HeaderCell>{t("academicGrading.results.columns.outcome")}</Table.HeaderCell>
        </Table.Row>
      </Table.Header>
      <Table.Body columnCount={7} empty={t("academicGrading.results.noStudents")}>
        {students.map((student) => {
          const missing = student.subjects.filter((subject) => subject.status === "incomplete");
          return (
            <Table.Row key={student.student_id}>
              <Table.Cell>
                {student.first_name} {student.last_name}
                <div className="ag-muted">{student.admission_number}</div>
              </Table.Cell>
              <Table.Cell>
                <Badge tone={student.status === "complete" ? "success" : "warning"}>
                  {t(`academicGrading.completeness.${student.status}`)}
                </Badge>
                {missing.length > 0 ? (
                  <ul className="ag-missing">
                    {missing.map((subject) => (
                      <li key={subject.subject_id}>
                        {"missing_assessments" in subject && subject.missing_assessments.length > 0
                          ? t("academicGrading.results.missingIn", {
                              subject: subject.subject_name,
                              assessments: subject.missing_assessments.join(", "),
                            })
                          : subject.subject_name}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </Table.Cell>
              <Table.Cell>
                <Percent value={student.average_percentage} />
              </Table.Cell>
              <Table.Cell>
                {student.total_obtained === null ? (
                  "—"
                ) : (
                  <>
                    <Num value={student.total_obtained} /> / <Num value={student.total_max} />
                  </>
                )}
              </Table.Cell>
              <Table.Cell>{student.grade_label ?? "—"}</Table.Cell>
              <Table.Cell>
                <Num value={student.subjects_failed} />
              </Table.Cell>
              <Table.Cell>
                <Badge tone={ACADEMIC_STATUS_TONE[student.academic_status] ?? "neutral"}>
                  {t(`academicGrading.academicStatus.${student.academic_status}`)}
                </Badge>
              </Table.Cell>
            </Table.Row>
          );
        })}
      </Table.Body>
    </Table>
  );
}

function FinalizationPanel({
  ctx,
  finalizationId,
  summary,
  sectionId,
  onCorrected,
}: {
  ctx: SetupContext;
  finalizationId: string;
  summary: ResultFinalizationSummary | undefined;
  sectionId: string;
  onCorrected: (newFinalizationId: string) => void;
}) {
  const { t } = useTranslation();
  const detail = useFinalizationDetail(finalizationId);
  const [correcting, setCorrecting] = useState(false);
  const finalization = detail.data?.finalization;
  const isCurrent = finalization?.status === "finalized";
  const periodLabel = summary?.term_name ?? t("academicGrading.results.annual");

  return (
    <section className="ag-block ag-card" aria-labelledby="ag-finalization-heading">
      <div className="ag-head">
        <h2 id="ag-finalization-heading">
          {t("academicGrading.results.finalizationHeading", {
            period: periodLabel,
            n: finalization?.version ?? summary?.version ?? "",
          })}
        </h2>
        {ctx.can.finalize && isCurrent && ctx.status !== "archived" ? (
          <Button type="button" variant="secondary" onClick={() => setCorrecting(true)}>
            {t("academicGrading.results.correct")}
          </Button>
        ) : null}
      </div>
      {finalization && !isCurrent ? (
        <p className="ag-notice">{t("academicGrading.results.supersededNotice")}</p>
      ) : null}
      <QueryState isPending={detail.isPending} error={detail.error}>
        {detail.data ? <StudentResultsTable students={detail.data.results} /> : null}
      </QueryState>
      {ctx.can.certify && detail.data ? (
        <CertificatesPanel ctx={ctx} finalizationId={finalizationId} current={isCurrent} />
      ) : null}
      {correcting && detail.data ? (
        <CorrectionForm
          detail={detail.data}
          sectionId={sectionId}
          onClose={() => setCorrecting(false)}
          onDone={(id) => {
            setCorrecting(false);
            onCorrected(id);
          }}
        />
      ) : null}
    </section>
  );
}

type MarkStatus = NonNullable<CorrectResultsBody["marks"]>[number]["status"];
const MARK_STATUSES: readonly MarkStatus[] = [
  "graded",
  "absent",
  "excused",
  "not_applicable",
  "pending",
];

interface MarkChange {
  key: string;
  subjectName: string;
  studentName: string;
  assessmentName: string;
  mark: NonNullable<CorrectResultsBody["marks"]>[number];
}

/**
 * An authorized correction of finalized results: the changed marks and a reason. The API stores
 * a new version and keeps the corrected one, superseded, for the record.
 */
function CorrectionForm({
  detail,
  sectionId,
  onClose,
  onDone,
}: {
  detail: ResultFinalizationDetail;
  sectionId: string;
  onClose: () => void;
  onDone: (newFinalizationId: string) => void;
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  const correct = useCorrectResults();
  const subjects = new Map<string, string>();
  for (const student of detail.results) {
    for (const subject of student.subjects) subjects.set(subject.subject_id, subject.subject_name);
  }
  const [subjectId, setSubjectId] = useState<string>();
  const [studentId, setStudentId] = useState<string>();
  const [assessmentId, setAssessmentId] = useState<string>();
  const [attempt, setAttempt] = useState<"1" | "2">("1");
  const [status, setStatus] = useState<MarkStatus>("graded");
  const [score, setScore] = useState("");
  const [reason, setReason] = useState("");
  const [allowIncomplete, setAllowIncomplete] = useState(false);
  const [changes, setChanges] = useState<MarkChange[]>([]);
  const [touched, setTouched] = useState(false);
  const sheet = useMarkSheet(sectionId, subjectId);
  const assessments = sheet.data?.assessments.filter((a) => a.status === "active") ?? [];
  const assessment = assessments.find((a) => a.id === assessmentId);
  const student = detail.results.find((s) => s.student_id === studentId);
  const recorded = sheet.data?.students
    .find((s) => s.student_id === studentId)
    ?.marks.find((m) => m.assessment_id === assessmentId && m.attempt === Number(attempt));
  const scoreValid = status !== "graded" || (score.trim() !== "" && Number.isFinite(Number(score)));
  const canAdd =
    subjectId !== undefined && student !== undefined && assessment !== undefined && scoreValid;

  function add() {
    if (!canAdd || !student || !assessment || !subjectId) return;
    setChanges((prev) => [
      ...prev.filter(
        (c) =>
          !(
            c.mark.student_id === student.student_id &&
            c.mark.assessment_id === assessment.id &&
            c.mark.attempt === Number(attempt)
          ),
      ),
      {
        key: `${student.student_id}-${assessment.id}-${attempt}`,
        subjectName: subjects.get(subjectId) ?? "",
        studentName: `${student.first_name} ${student.last_name}`,
        assessmentName: assessment.name,
        mark: {
          assessment_id: assessment.id,
          student_id: student.student_id,
          attempt: attempt === "2" ? 2 : 1,
          status,
          score: status === "graded" ? Number(score) : null,
        },
      },
    ]);
    setScore("");
  }

  function submit() {
    setTouched(true);
    if (reason.trim() === "" || changes.length === 0) return;
    correct.mutate(
      {
        finalizationId: detail.finalization.id,
        body: {
          reason: reason.trim(),
          marks: changes.map((change) => change.mark),
          allow_incomplete: allowIncomplete,
        },
      },
      {
        onSuccess: (result) => {
          show({
            variant: "success",
            title: t("academicGrading.results.corrected", { n: result.version }),
          });
          onDone(result.id);
        },
      },
    );
  }

  return (
    <ConfirmModal
      open
      title={t("academicGrading.correction.title")}
      description={t("academicGrading.correction.description")}
      confirmLabel={t("academicGrading.correction.submit")}
      submitting={correct.isPending}
      confirmDisabled={changes.length === 0}
      onCancel={onClose}
      onConfirm={submit}
    >
      <div className="ag-form">
        <Select
          label={t("academicGrading.correction.subject")}
          options={[...subjects].map(([value, label]) => ({ value, label }))}
          value={subjectId}
          onChange={(value) => {
            setSubjectId(value);
            setAssessmentId(undefined);
          }}
        />
        <Select
          label={t("academicGrading.correction.student")}
          options={detail.results.map((s) => ({
            value: s.student_id,
            label: `${s.first_name} ${s.last_name}`,
          }))}
          value={studentId}
          onChange={setStudentId}
        />
        <Select
          label={t("academicGrading.correction.assessment")}
          options={assessments.map((a) => ({ value: a.id, label: a.name }))}
          value={assessmentId}
          onChange={setAssessmentId}
          placeholder={
            subjectId && sheet.isPending
              ? t("academicGrading.common.loading")
              : t("academicGrading.correction.pickAssessment")
          }
          disabled={assessments.length === 0}
        />
        {sheet.isError ? (
          <p className="ag-error" role="alert">
            {problemMessage(sheet.error, t)}
          </p>
        ) : null}
        <div className="ag-grid ag-grid--dense">
          <Select<"1" | "2">
            label={t("academicGrading.correction.attempt")}
            options={[
              { value: "1", label: t("academicGrading.correction.original") },
              { value: "2", label: t("academicGrading.correction.retake") },
            ]}
            value={attempt}
            onChange={setAttempt}
          />
          <Select<MarkStatus>
            label={t("academicGrading.correction.status")}
            options={MARK_STATUSES.map((value) => ({
              value,
              label: t(`academicGrading.markStatus.${value}`),
            }))}
            value={status}
            onChange={setStatus}
          />
          {status === "graded" ? (
            <Input
              label={t("academicGrading.correction.score")}
              type="number"
              min={0}
              max={assessment?.max_marks}
              helperText={
                assessment
                  ? t("academicGrading.correction.outOf", { max: assessment.max_marks })
                  : undefined
              }
              value={score}
              onChange={(event) => setScore(event.target.value)}
            />
          ) : null}
        </div>
        {recorded ? (
          <p className="ag-muted">
            {t("academicGrading.correction.recorded", {
              value:
                recorded.status === "graded"
                  ? String(recorded.score)
                  : t(`academicGrading.markStatus.${recorded.status}`),
            })}
          </p>
        ) : null}
        <Button type="button" variant="secondary" disabled={!canAdd} onClick={add}>
          {t("academicGrading.correction.add")}
        </Button>
        {changes.length > 0 ? (
          <ul className="ag-list" aria-label={t("academicGrading.correction.changes")}>
            {changes.map((change) => (
              <li key={change.key}>
                {t("academicGrading.correction.change", {
                  student: change.studentName,
                  subject: change.subjectName,
                  assessment: change.assessmentName,
                  value:
                    change.mark.status === "graded"
                      ? String(change.mark.score)
                      : t(`academicGrading.markStatus.${change.mark.status}`),
                })}{" "}
                <Button
                  type="button"
                  variant="tertiary"
                  onClick={() => setChanges((prev) => prev.filter((c) => c.key !== change.key))}
                >
                  {t("academicGrading.common.remove")}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="ag-muted">{t("academicGrading.correction.noChanges")}</p>
        )}
        <TextArea
          label={t("academicGrading.common.reason")}
          value={reason}
          onChange={setReason}
          required
          error={
            touched && reason.trim() === "" ? t("academicGrading.common.reasonRequired") : undefined
          }
        />
        <Checkbox
          label={t("academicGrading.correction.allowIncomplete")}
          checked={allowIncomplete}
          onChange={(event) => setAllowIncomplete(event.target.checked)}
        />
        {correct.isError ? (
          <p className="ag-error" role="alert">
            {problemMessage(correct.error, t)}
          </p>
        ) : null}
      </div>
    </ConfirmModal>
  );
}

function CertificatesPanel({
  ctx,
  finalizationId,
  current,
}: {
  ctx: SetupContext;
  finalizationId: string;
  current: boolean;
}) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const { show } = useToast();
  const readiness = useCertificateReadiness(current ? finalizationId : undefined);
  const certificates = useFinalizationCertificates(finalizationId);
  const issue = useIssueCertificates();
  const reissue = useReissueCertificate();
  const revoke = useRevokeCertificate();
  const [reasonFor, setReasonFor] = useState<{
    certificate: AcademicCertificate;
    action: "reissue" | "revoke";
  } | null>(null);
  const students = readiness.data ?? [];
  const readyCount = students.filter((s) => s.state === "ready").length;

  function issueFor(studentIds?: string[]) {
    issue.mutate(
      { finalizationId, studentIds },
      {
        onSuccess: (result) =>
          show({
            variant: result.skipped.length > 0 ? "warning" : "success",
            title: t("academicGrading.certificates.issued", { count: result.issued.length }),
            description:
              result.skipped.length > 0
                ? t("academicGrading.certificates.skipped", { count: result.skipped.length })
                : undefined,
          }),
        onError: (error) =>
          show({
            variant: "error",
            title: t("academicGrading.certificates.issueFailed"),
            description: problemMessage(error, t),
          }),
      },
    );
  }

  function decide(reason: string) {
    if (!reasonFor) return;
    const mutation = reasonFor.action === "reissue" ? reissue : revoke;
    mutation.mutate(
      { certificateId: reasonFor.certificate.id, reason },
      {
        onSuccess: () => {
          show({
            variant: "success",
            title: t(`academicGrading.certificates.${reasonFor.action}d`),
          });
          setReasonFor(null);
        },
        onError: (error) =>
          show({
            variant: "error",
            title: t("academicGrading.certificates.actionFailed"),
            description: problemMessage(error, t),
          }),
      },
    );
  }

  const certificateFor = (certificateId: string | null) =>
    certificates.data?.find((c) => c.id === certificateId);

  return (
    <section className="ag-block" aria-labelledby="ag-certificates-heading">
      <div className="ag-head">
        <h3 id="ag-certificates-heading" className="ag-subheading">
          {t("academicGrading.certificates.heading")}
        </h3>
        {current ? (
          <Button
            type="button"
            disabled={readyCount === 0}
            loading={issue.isPending && issue.variables?.studentIds === undefined}
            onClick={() => issueFor()}
          >
            {t("academicGrading.certificates.issueAll", {
              count: readyCount,
              formatted: formatNumber(readyCount),
            })}
          </Button>
        ) : null}
      </div>
      {current ? (
        <QueryState isPending={readiness.isPending} error={readiness.error}>
          <Table caption={t("academicGrading.certificates.readinessCaption")} hideCaption>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>{t("academicGrading.results.columns.student")}</Table.HeaderCell>
                <Table.HeaderCell>
                  {t("academicGrading.certificates.columns.state")}
                </Table.HeaderCell>
                <Table.HeaderCell>
                  {t("academicGrading.certificates.columns.reasons")}
                </Table.HeaderCell>
                <Table.HeaderCell>
                  {t("academicGrading.certificates.columns.actions")}
                </Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body columnCount={4} empty={t("academicGrading.results.noStudents")}>
              {students.map((student) => {
                const name = `${student.first_name} ${student.last_name}`;
                const certificate = certificateFor(student.certificate_id);
                return (
                  <Table.Row key={student.student_id}>
                    <Table.Cell>{name}</Table.Cell>
                    <Table.Cell>
                      <Badge tone={READINESS_TONE[student.state]}>
                        {t(`academicGrading.readiness.${student.state}`)}
                      </Badge>
                    </Table.Cell>
                    <Table.Cell>
                      {student.reasons.length > 0 ? (
                        <ul className="ag-missing">
                          {student.reasons.map((reason) => (
                            <li key={reason}>{reason}</li>
                          ))}
                        </ul>
                      ) : (
                        "—"
                      )}
                    </Table.Cell>
                    <Table.Cell>
                      <div className="sections-page__row-actions">
                        {student.state === "ready" ? (
                          <Button
                            type="button"
                            variant="secondary"
                            aria-label={t("academicGrading.certificates.issueLabel", { name })}
                            loading={
                              issue.isPending &&
                              issue.variables?.studentIds?.[0] === student.student_id
                            }
                            onClick={() => issueFor([student.student_id])}
                          >
                            {t("academicGrading.certificates.issue")}
                          </Button>
                        ) : null}
                        {student.certificate_id ? (
                          <Link
                            to={setupHref(ctx, `certificates/${student.certificate_id}`)}
                            aria-label={t("academicGrading.certificates.viewLabel", { name })}
                          >
                            {t("academicGrading.certificates.view")}
                          </Link>
                        ) : null}
                        {certificate && student.state === "needs_reissue" ? (
                          <Button
                            type="button"
                            variant="secondary"
                            aria-label={t("academicGrading.certificates.reissueLabel", { name })}
                            onClick={() => setReasonFor({ certificate, action: "reissue" })}
                          >
                            {t("academicGrading.certificates.reissue")}
                          </Button>
                        ) : null}
                      </div>
                    </Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table>
        </QueryState>
      ) : (
        <p className="ag-muted">{t("academicGrading.certificates.supersededHelp")}</p>
      )}

      <h3 className="ag-subheading">{t("academicGrading.certificates.issuedHeading")}</h3>
      <Table caption={t("academicGrading.certificates.issuedCaption")} hideCaption>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>{t("academicGrading.certificates.columns.serial")}</Table.HeaderCell>
            <Table.HeaderCell>{t("academicGrading.results.columns.student")}</Table.HeaderCell>
            <Table.HeaderCell>{t("academicGrading.certificates.columns.status")}</Table.HeaderCell>
            <Table.HeaderCell>
              {t("academicGrading.certificates.columns.issuedAt")}
            </Table.HeaderCell>
            <Table.HeaderCell>{t("academicGrading.certificates.columns.actions")}</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body
          columnCount={5}
          loading={certificates.isPending}
          empty={
            certificates.isError
              ? problemMessage(certificates.error, t)
              : t("academicGrading.certificates.none")
          }
        >
          {(certificates.data ?? []).map((certificate) => {
            const name = `${certificate.content.student.first_name} ${certificate.content.student.last_name}`;
            return (
              <Table.Row key={certificate.id}>
                <Table.Cell>{certificate.serial_number}</Table.Cell>
                <Table.Cell>{name}</Table.Cell>
                <Table.Cell>
                  <Badge
                    tone={
                      certificate.status === "issued"
                        ? certificate.needs_reissue
                          ? "warning"
                          : "success"
                        : certificate.status === "revoked"
                          ? "danger"
                          : "neutral"
                    }
                  >
                    {t(`academicGrading.certificateStatus.${certificate.status}`)}
                  </Badge>
                  {certificate.status === "issued" && certificate.needs_reissue ? (
                    <div className="ag-muted">{t("academicGrading.readiness.needs_reissue")}</div>
                  ) : null}
                </Table.Cell>
                <Table.Cell>
                  <DateTime value={certificate.issued_at} />
                </Table.Cell>
                <Table.Cell>
                  <div className="sections-page__row-actions">
                    <Link
                      to={setupHref(ctx, `certificates/${certificate.id}`)}
                      aria-label={t("academicGrading.certificates.viewSerialLabel", {
                        serial: certificate.serial_number,
                      })}
                    >
                      {t("academicGrading.certificates.view")}
                    </Link>
                    {certificate.status === "issued" ? (
                      <>
                        <Button
                          type="button"
                          variant="tertiary"
                          aria-label={t("academicGrading.certificates.reissueSerialLabel", {
                            serial: certificate.serial_number,
                          })}
                          onClick={() => setReasonFor({ certificate, action: "reissue" })}
                        >
                          {t("academicGrading.certificates.reissue")}
                        </Button>
                        <Button
                          type="button"
                          variant="tertiary"
                          aria-label={t("academicGrading.certificates.revokeSerialLabel", {
                            serial: certificate.serial_number,
                          })}
                          onClick={() => setReasonFor({ certificate, action: "revoke" })}
                        >
                          {t("academicGrading.certificates.revoke")}
                        </Button>
                      </>
                    ) : null}
                  </div>
                </Table.Cell>
              </Table.Row>
            );
          })}
        </Table.Body>
      </Table>

      {reasonFor ? (
        <ReasonModal
          key={`${reasonFor.certificate.id}-${reasonFor.action}`}
          open
          title={t(`academicGrading.certificates.${reasonFor.action}Title`, {
            serial: reasonFor.certificate.serial_number,
          })}
          description={t(`academicGrading.certificates.${reasonFor.action}Description`)}
          confirmLabel={t(`academicGrading.certificates.${reasonFor.action}`)}
          submitting={reissue.isPending || revoke.isPending}
          onCancel={() => setReasonFor(null)}
          onConfirm={decide}
        />
      ) : null}
    </section>
  );
}
