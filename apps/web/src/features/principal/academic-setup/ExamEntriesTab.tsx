import { ERROR_CODES } from "@studafy/constants";
import { Button, Checkbox, Input, Modal, Select, Table, useToast } from "@studafy/ui";
import { useState } from "react";

import { downloadBlob } from "../../../lib/csv";
import { useFormatters, useTranslation } from "../../../lib/i18n";
import { useSubjects } from "../school/queries";
import {
  sectionDisplayName,
  useGradeLevels,
  useSections,
  useSectionStudents,
} from "../sections/queries";

import { Badge, ConfirmModal, TextArea } from "./components";
import { isProblem, problemMessage } from "./errors";
import {
  fetchExamEntriesCsv,
  useAssignCandidateNumbers,
  useChangeExamEntryStatus,
  useCreateExamEntries,
  useDeleteExamEntry,
  useDeleteExamSession,
  useExamSessionEntries,
  useExamSessions,
  useSaveExamSession,
  useUpdateExamEntry,
} from "./exam-entries";
import { useExternalExams } from "./external-exams";

import type { BadgeTone } from "./components";
import type { SetupContext } from "./context";
import type { ExamEntry, ExamEntryStatus, ExamEntrySubjectBody, ExamSession } from "./exam-entries";
import type { FormEvent } from "react";

const STATUS_TONES: Record<ExamEntryStatus, BadgeTone> = {
  draft: "neutral",
  entered: "success",
  withdrawn: "warning",
};

/** The subjects chosen for an entry, each with its tier and the board's option code as typed. */
type SubjectChoice = Map<string, { tier: string; optionCode: string }>;

function subjectBodies(choice: SubjectChoice): ExamEntrySubjectBody[] {
  return [...choice].map(([subjectId, { tier, optionCode }]) => ({
    subject_id: subjectId,
    tier: tier.trim() === "" ? null : tier.trim(),
    option_code: optionCode.trim() === "" ? null : optionCode.trim(),
  }));
}

const blankToNull = (value: string) => (value.trim() === "" ? null : value.trim());

function useDay() {
  const { formatDate } = useFormatters();
  return (date: string | null) =>
    date ? formatDate(new Date(`${date}T00:00:00`), { dateStyle: "medium" }) : "—";
}

/**
 * Exam entries (leadership): sessions of the school's external exams ("IGCSE May/June 2027") and
 * the students entered for them. A session opens on its entry list: enter students by grade,
 * section or a chosen list, set candidate numbers, mark entries as sent to the board, withdraw or
 * reinstate them, see how many students take each subject and download the list for the board.
 * Not tied to the selected academic year, except that grades and sections are picked from it.
 */
export function ExamEntriesTab({ ctx }: { ctx: SetupContext }) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const { show } = useToast();
  const day = useDay();
  const sessions = useExamSessions();
  const remove = useDeleteExamSession();
  const [editing, setEditing] = useState<{ session: ExamSession | null } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ExamSession | null>(null);

  if (openId) {
    return <SessionEntries ctx={ctx} sessionId={openId} onClose={() => setOpenId(null)} />;
  }

  return (
    <section className="ag-block" aria-labelledby="ag-exam-entries-heading">
      <div className="ag-head">
        <h2 id="ag-exam-entries-heading">{t("academicGrading.examEntries.heading")}</h2>
        <Button type="button" variant="secondary" onClick={() => setEditing({ session: null })}>
          {t("academicGrading.examEntries.addSession")}
        </Button>
      </div>
      <p className="ag-muted">{t("academicGrading.examEntries.help")}</p>
      <Table caption={t("academicGrading.examEntries.caption")} hideCaption>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>{t("academicGrading.examEntries.columns.session")}</Table.HeaderCell>
            <Table.HeaderCell>{t("academicGrading.examEntries.columns.dates")}</Table.HeaderCell>
            <Table.HeaderCell>{t("academicGrading.examEntries.columns.deadline")}</Table.HeaderCell>
            <Table.HeaderCell>{t("academicGrading.examEntries.columns.entries")}</Table.HeaderCell>
            <Table.HeaderCell>{t("academicGrading.examEntries.columns.actions")}</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body
          columnCount={5}
          loading={sessions.isPending}
          empty={
            sessions.isError
              ? problemMessage(sessions.error, t)
              : t("academicGrading.examEntries.empty")
          }
        >
          {(sessions.data ?? []).map((session) => {
            const total = session.draft_count + session.entered_count + session.withdrawn_count;
            const name = `${session.exam.name} — ${session.series}`;
            return (
              <Table.Row key={session.id}>
                <Table.Cell>
                  <strong>{session.exam.name}</strong>{" "}
                  <span className="ag-muted">{session.series}</span>
                  {session.exam.archived ? (
                    <div>
                      <Badge tone="neutral">{t("academicGrading.externalExams.archived")}</Badge>
                    </div>
                  ) : null}
                </Table.Cell>
                <Table.Cell>
                  {session.starts_on
                    ? t("academicGrading.examEntries.dateRange", {
                        from: day(session.starts_on),
                        to: day(session.ends_on ?? session.starts_on),
                      })
                    : "—"}
                  {session.results_date ? (
                    <div className="ag-muted">
                      {t("academicGrading.examEntries.resultsOn", {
                        date: day(session.results_date),
                      })}
                    </div>
                  ) : null}
                </Table.Cell>
                <Table.Cell>{day(session.entry_deadline)}</Table.Cell>
                <Table.Cell>
                  {t("academicGrading.examEntries.counts", {
                    entered: formatNumber(session.entered_count),
                    draft: formatNumber(session.draft_count),
                    withdrawn: formatNumber(session.withdrawn_count),
                  })}
                </Table.Cell>
                <Table.Cell>
                  <div className="sections-page__row-actions">
                    <Button
                      type="button"
                      variant="secondary"
                      aria-label={t("academicGrading.examEntries.openLabel", { name })}
                      onClick={() => setOpenId(session.id)}
                    >
                      {t("academicGrading.examEntries.open")}
                    </Button>
                    <Button
                      type="button"
                      variant="tertiary"
                      aria-label={t("academicGrading.examEntries.editSessionLabel", { name })}
                      onClick={() => setEditing({ session })}
                    >
                      {t("academicGrading.common.edit")}
                    </Button>
                    {total === 0 ? (
                      <Button
                        type="button"
                        variant="tertiary"
                        aria-label={t("academicGrading.examEntries.deleteSessionLabel", { name })}
                        onClick={() => setPendingDelete(session)}
                      >
                        {t("academicGrading.common.remove")}
                      </Button>
                    ) : null}
                  </div>
                </Table.Cell>
              </Table.Row>
            );
          })}
        </Table.Body>
      </Table>
      {editing ? <SessionForm session={editing.session} onClose={() => setEditing(null)} /> : null}
      <ConfirmModal
        open={pendingDelete !== null}
        title={t("academicGrading.examEntries.deleteSessionTitle", {
          name: pendingDelete ? `${pendingDelete.exam.name} — ${pendingDelete.series}` : "",
        })}
        confirmLabel={t("academicGrading.common.remove")}
        submitting={remove.isPending}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() =>
          pendingDelete &&
          remove.mutate(pendingDelete.id, {
            onSuccess: () => {
              show({ variant: "success", title: t("academicGrading.examEntries.sessionDeleted") });
              setPendingDelete(null);
            },
            onError: (error) => {
              show({
                variant: "error",
                title: t("academicGrading.examEntries.saveFailed"),
                description: problemMessage(error, t),
              });
              setPendingDelete(null);
            },
          })
        }
      />
    </section>
  );
}

/** Add a session of an active exam, or edit one's series, dates and note (its exam stays). */
function SessionForm({ session, onClose }: { session: ExamSession | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { show } = useToast();
  const exams = useExternalExams(false, session === null);
  const save = useSaveExamSession();
  const [examId, setExamId] = useState<string | undefined>(session?.exam.id);
  const [series, setSeries] = useState(session?.series ?? "");
  const [deadline, setDeadline] = useState(session?.entry_deadline ?? "");
  const [startsOn, setStartsOn] = useState(session?.starts_on ?? "");
  const [endsOn, setEndsOn] = useState(session?.ends_on ?? "");
  const [resultsDate, setResultsDate] = useState(session?.results_date ?? "");
  const [note, setNote] = useState(session?.note ?? "");

  const datesWrong = endsOn !== "" && (startsOn === "" || endsOn < startsOn);
  const incomplete = series.trim() === "" || (!session && !examId) || datesWrong;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (incomplete) return;
    const body = {
      series: series.trim(),
      entry_deadline: deadline || null,
      starts_on: startsOn || null,
      ends_on: endsOn || null,
      results_date: resultsDate || null,
      note: blankToNull(note),
    };
    save.mutate(
      session
        ? { sessionId: session.id, body }
        : { sessionId: null, body: { exam_id: examId!, ...body } },
      {
        onSuccess: () => {
          show({ variant: "success", title: t("academicGrading.examEntries.sessionSaved") });
          onClose();
        },
      },
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="wide"
      title={
        session
          ? t("academicGrading.examEntries.editSessionTitle", {
              name: `${session.exam.name} — ${session.series}`,
            })
          : t("academicGrading.examEntries.addSession")
      }
    >
      <form onSubmit={submit} noValidate>
        <Modal.Body>
          <div className="ag-grid ag-grid--dense">
            <Select
              label={t("academicGrading.examEntries.exam")}
              placeholder={t("academicGrading.examEntries.examPlaceholder")}
              options={
                session
                  ? [{ value: session.exam.id, label: session.exam.name }]
                  : (exams.data ?? []).map((exam) => ({ value: exam.id, label: exam.name }))
              }
              value={examId}
              required
              disabled={session !== null}
              onChange={setExamId}
            />
            <Input
              label={t("academicGrading.examEntries.series")}
              helperText={t("academicGrading.examEntries.seriesHelp")}
              value={series}
              required
              maxLength={120}
              onChange={(event) => setSeries(event.target.value)}
            />
            <Input
              label={t("academicGrading.examEntries.entryDeadline")}
              type="date"
              value={deadline}
              onChange={(event) => setDeadline(event.target.value)}
            />
            <Input
              label={t("academicGrading.examEntries.startsOn")}
              type="date"
              value={startsOn}
              onChange={(event) => setStartsOn(event.target.value)}
            />
            <Input
              label={t("academicGrading.examEntries.endsOn")}
              type="date"
              value={endsOn}
              error={datesWrong ? t("academicGrading.examEntries.endsOnError") : undefined}
              onChange={(event) => setEndsOn(event.target.value)}
            />
            <Input
              label={t("academicGrading.examEntries.resultsDate")}
              type="date"
              value={resultsDate}
              onChange={(event) => setResultsDate(event.target.value)}
            />
          </div>
          <TextArea label={t("academicGrading.examEntries.note")} value={note} onChange={setNote} />
          {save.isError ? (
            <p className="ag-error" role="alert">
              {isProblem(save.error, ERROR_CODES.CONFLICT_DUPLICATE_ENTRY)
                ? t("academicGrading.examEntries.duplicateSeries")
                : problemMessage(save.error, t)}
            </p>
          ) : null}
        </Modal.Body>
        <Modal.Footer>
          <Button type="button" variant="tertiary" onClick={onClose}>
            {t("academicGrading.common.cancel")}
          </Button>
          <Button type="submit" loading={save.isPending} disabled={incomplete}>
            {t("academicGrading.examEntries.saveSession")}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}

/** Pick subjects, each with an optional tier and option code. */
function SubjectPicker({
  legend,
  value,
  onChange,
}: {
  legend: string;
  value: SubjectChoice;
  onChange: (next: SubjectChoice) => void;
}) {
  const { t } = useTranslation();
  const subjects = useSubjects();
  const set = (subjectId: string, changes: Partial<{ tier: string; optionCode: string }>) => {
    const next = new Map(value);
    next.set(subjectId, { tier: "", optionCode: "", ...value.get(subjectId), ...changes });
    onChange(next);
  };
  return (
    <fieldset className="ag-fieldset">
      <legend>{legend}</legend>
      {subjects.isError ? (
        <p className="ag-error" role="alert">
          {problemMessage(subjects.error, t)}
        </p>
      ) : null}
      {(subjects.data ?? []).map((subject) => {
        const chosen = value.get(subject.id);
        return (
          <div key={subject.id} className="ag-row ag-grid ag-grid--dense">
            <Checkbox
              label={subject.name}
              checked={chosen !== undefined}
              onChange={(event) => {
                const next = new Map(value);
                if (event.target.checked) next.set(subject.id, { tier: "", optionCode: "" });
                else next.delete(subject.id);
                onChange(next);
              }}
            />
            {chosen ? (
              <>
                <Input
                  label={t("academicGrading.examEntries.tierFor", { subject: subject.name })}
                  helperText={t("academicGrading.examEntries.tierHelp")}
                  value={chosen.tier}
                  maxLength={40}
                  onChange={(event) => set(subject.id, { tier: event.target.value })}
                />
                <Input
                  label={t("academicGrading.examEntries.optionCodeFor", { subject: subject.name })}
                  value={chosen.optionCode}
                  maxLength={40}
                  onChange={(event) => set(subject.id, { optionCode: event.target.value })}
                />
              </>
            ) : null}
          </div>
        );
      })}
    </fieldset>
  );
}

type EnterMode = "grade" | "section" | "students";

/** Enter a whole grade, a section, or students chosen from a section. */
function EnterStudentsForm({ ctx, session }: { ctx: SetupContext; session: ExamSession }) {
  const { t } = useTranslation();
  const { show } = useToast();
  const grades = useGradeLevels();
  const sections = useSections(ctx.year.id);
  const create = useCreateExamEntries(session.id);
  const [mode, setMode] = useState<EnterMode>("section");
  const [gradeId, setGradeId] = useState<string | undefined>(undefined);
  const [sectionId, setSectionId] = useState<string | undefined>(undefined);
  const [studentIds, setStudentIds] = useState<Set<string>>(new Set());
  const [subjects, setSubjects] = useState<SubjectChoice>(new Map());
  const [status, setStatus] = useState<"draft" | "entered">("draft");
  const roster = useSectionStudents(mode === "students" ? sectionId : undefined);

  const who =
    mode === "grade"
      ? gradeId !== undefined
      : mode === "section"
        ? sectionId !== undefined
        : studentIds.size > 0;
  const incomplete = !who || (session.exam.per_subject && subjects.size === 0);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (incomplete) return;
    create.mutate(
      {
        ...(mode === "grade"
          ? { grade_level_id: gradeId!, academic_year_id: ctx.year.id }
          : mode === "section"
            ? { section_id: sectionId! }
            : { student_ids: [...studentIds] }),
        subjects: session.exam.per_subject ? subjectBodies(subjects) : [],
        status,
      },
      {
        onSuccess: (result) => {
          show({
            variant: "success",
            title: t("academicGrading.examEntries.entered", {
              created: result.created,
              updated: result.updated,
            }),
            description:
              result.skipped_withdrawn > 0
                ? t("academicGrading.examEntries.skippedWithdrawn", {
                    count: result.skipped_withdrawn,
                  })
                : undefined,
          });
          setStudentIds(new Set());
        },
      },
    );
  }

  return (
    <form className="ag-fieldset" onSubmit={submit} noValidate>
      <h3>{t("academicGrading.examEntries.enterHeading")}</h3>
      <div className="ag-grid ag-grid--dense">
        <Select<EnterMode>
          label={t("academicGrading.examEntries.who")}
          options={(["grade", "section", "students"] as const).map((value) => ({
            value,
            label: t(`academicGrading.examEntries.whoOptions.${value}`),
          }))}
          value={mode}
          onChange={(value) => {
            setMode(value);
            setStudentIds(new Set());
          }}
        />
        {mode === "grade" ? (
          <Select
            label={t("academicGrading.examEntries.grade")}
            placeholder={t("academicGrading.examEntries.gradePlaceholder")}
            options={(grades.data ?? []).map((grade) => ({ value: grade.id, label: grade.name }))}
            value={gradeId}
            onChange={setGradeId}
          />
        ) : (
          <Select
            label={t("academicGrading.examEntries.section")}
            placeholder={t("academicGrading.examEntries.sectionPlaceholder")}
            options={(sections.data ?? []).map((section) => ({
              value: section.id,
              label: sectionDisplayName(section, t),
            }))}
            value={sectionId}
            onChange={(id) => {
              setSectionId(id);
              setStudentIds(new Set());
            }}
          />
        )}
        <Select<"draft" | "entered">
          label={t("academicGrading.examEntries.newStatus")}
          options={(["draft", "entered"] as const).map((value) => ({
            value,
            label: t(`academicGrading.examEntries.status.${value}`),
          }))}
          value={status}
          onChange={setStatus}
        />
      </div>
      {mode === "students" && sectionId ? (
        <fieldset className="ag-fieldset">
          <legend>{t("academicGrading.examEntries.students")}</legend>
          {roster.isPending ? (
            <p className="ag-muted" role="status">
              {t("academicGrading.common.loading")}
            </p>
          ) : (roster.data ?? []).length === 0 ? (
            <p className="ag-muted">{t("academicGrading.examEntries.noStudents")}</p>
          ) : (
            (roster.data ?? []).map((student) => (
              <Checkbox
                key={student.student_id}
                label={`${student.first_name} ${student.last_name} (${student.admission_number})`}
                checked={studentIds.has(student.student_id)}
                onChange={(event) => {
                  const next = new Set(studentIds);
                  if (event.target.checked) next.add(student.student_id);
                  else next.delete(student.student_id);
                  setStudentIds(next);
                }}
              />
            ))
          )}
        </fieldset>
      ) : null}
      {session.exam.per_subject ? (
        <SubjectPicker
          legend={t("academicGrading.examEntries.subjects")}
          value={subjects}
          onChange={setSubjects}
        />
      ) : (
        <p className="ag-muted">{t("academicGrading.examEntries.wholeExam")}</p>
      )}
      {create.isError ? (
        <p className="ag-error" role="alert">
          {problemMessage(create.error, t)}
        </p>
      ) : null}
      <div className="ag-row__actions">
        <Button type="submit" loading={create.isPending} disabled={incomplete}>
          {t("academicGrading.examEntries.enterSubmit")}
        </Button>
      </div>
    </form>
  );
}

/** One session: subject counts, entering students, numbering, the entry list and its actions. */
function SessionEntries({
  ctx,
  sessionId,
  onClose,
}: {
  ctx: SetupContext;
  sessionId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const { show } = useToast();
  const data = useExamSessionEntries(sessionId);
  const changeStatus = useChangeExamEntryStatus(sessionId);
  const assign = useAssignCandidateNumbers(sessionId);
  const remove = useDeleteExamEntry();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<ExamEntry | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ExamEntry | null>(null);
  const [start, setStart] = useState("1");
  const [width, setWidth] = useState("4");
  const [prefix, setPrefix] = useState("");
  const [includeDrafts, setIncludeDrafts] = useState(false);
  const [exporting, setExporting] = useState(false);

  if (data.isPending || data.isError) {
    return (
      <section className="ag-block">
        <Button type="button" variant="tertiary" onClick={onClose}>
          {t("academicGrading.editor.back")}
        </Button>
        {data.isError ? (
          <p className="ag-error" role="alert">
            {problemMessage(data.error, t)}
          </p>
        ) : (
          <p className="ag-muted" role="status">
            {t("academicGrading.common.loading")}
          </p>
        )}
      </section>
    );
  }

  const { session, entries, subject_counts } = data.data;
  const title = `${session.exam.name} — ${session.series}`;
  const chosen = entries.filter((entry) => selected.has(entry.id));
  const studentName = (entry: ExamEntry) =>
    `${entry.student.first_name} ${entry.student.last_name}`;

  function moveTo(status: ExamEntryStatus, from: ExamEntryStatus) {
    const ids = chosen.filter((entry) => entry.status === from).map((entry) => entry.id);
    if (ids.length === 0) return;
    changeStatus.mutate(
      { entry_ids: ids, status },
      {
        onSuccess: (updated) => {
          show({
            variant: "success",
            title: t(`academicGrading.examEntries.moved.${status}`, { count: updated }),
          });
          setSelected(new Set());
        },
        onError: (error) =>
          show({
            variant: "error",
            title: t("academicGrading.examEntries.saveFailed"),
            description: problemMessage(error, t),
          }),
      },
    );
  }

  function number(event: FormEvent) {
    event.preventDefault();
    assign.mutate(
      {
        start: Number(start),
        width: width.trim() === "" ? 0 : Number(width),
        prefix: prefix.trim(),
      },
      {
        onSuccess: (assigned) =>
          show({
            variant: "success",
            title: t("academicGrading.examEntries.numbered", { count: assigned }),
          }),
        onError: (error) =>
          show({
            variant: "error",
            title: t("academicGrading.examEntries.saveFailed"),
            description: problemMessage(error, t),
          }),
      },
    );
  }

  async function download() {
    setExporting(true);
    try {
      const slug = `${session.exam.code}-${session.series}`
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
      downloadBlob(
        `${slug || "exam"}-entries.csv`,
        await fetchExamEntriesCsv(sessionId, includeDrafts),
      );
    } catch (error) {
      show({
        variant: "error",
        title: t("academicGrading.examEntries.exportFailed"),
        description: problemMessage(error, t),
      });
    } finally {
      setExporting(false);
    }
  }

  const count = (status: ExamEntryStatus) => chosen.filter((e) => e.status === status).length;
  const numberIssue =
    start.trim() === "" || !Number.isInteger(Number(start)) || Number(start) < 0
      ? t("academicGrading.examEntries.startError")
      : undefined;

  return (
    <section className="ag-editor" aria-labelledby="ag-exam-session-heading">
      <div className="ag-head">
        <h2 id="ag-exam-session-heading">{title}</h2>
        <Button type="button" variant="tertiary" onClick={onClose}>
          {t("academicGrading.editor.back")}
        </Button>
      </div>
      <p className="ag-muted">
        {t("academicGrading.examEntries.counts", {
          entered: formatNumber(session.entered_count),
          draft: formatNumber(session.draft_count),
          withdrawn: formatNumber(session.withdrawn_count),
        })}
      </p>

      {session.exam.per_subject ? (
        <Table caption={t("academicGrading.examEntries.subjectCountsCaption")}>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>
                {t("academicGrading.examEntries.columns.subject")}
              </Table.HeaderCell>
              <Table.HeaderCell>{t("academicGrading.examEntries.status.entered")}</Table.HeaderCell>
              <Table.HeaderCell>{t("academicGrading.examEntries.status.draft")}</Table.HeaderCell>
              <Table.HeaderCell>
                {t("academicGrading.examEntries.status.withdrawn")}
              </Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body columnCount={4} empty={t("academicGrading.examEntries.noEntries")}>
            {subject_counts.map((row) => (
              <Table.Row key={row.subject_id}>
                <Table.Cell>{row.name}</Table.Cell>
                <Table.Cell>{formatNumber(row.entered)}</Table.Cell>
                <Table.Cell>{formatNumber(row.draft)}</Table.Cell>
                <Table.Cell>{formatNumber(row.withdrawn)}</Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      ) : null}

      {session.exam.archived ? (
        <p className="ag-notice" role="note">
          {t("academicGrading.examEntries.archivedNote")}
        </p>
      ) : (
        <EnterStudentsForm ctx={ctx} session={session} />
      )}

      <form className="ag-fieldset" onSubmit={number} noValidate>
        <h3>{t("academicGrading.examEntries.numberHeading")}</h3>
        <p className="ag-muted">{t("academicGrading.examEntries.numberHelp")}</p>
        <div className="ag-grid ag-grid--dense">
          <Input
            label={t("academicGrading.examEntries.numberPrefix")}
            value={prefix}
            maxLength={10}
            onChange={(event) => setPrefix(event.target.value)}
          />
          <Input
            label={t("academicGrading.examEntries.numberStart")}
            type="number"
            min={0}
            step={1}
            value={start}
            error={numberIssue}
            onChange={(event) => setStart(event.target.value)}
          />
          <Input
            label={t("academicGrading.examEntries.numberWidth")}
            type="number"
            min={0}
            max={10}
            step={1}
            value={width}
            onChange={(event) => setWidth(event.target.value)}
          />
        </div>
        <div className="ag-row__actions">
          <Button
            type="submit"
            variant="secondary"
            loading={assign.isPending}
            disabled={numberIssue !== undefined}
          >
            {t("academicGrading.examEntries.numberSubmit")}
          </Button>
        </div>
      </form>

      <div className="ag-head">
        <h3>{t("academicGrading.examEntries.entriesHeading")}</h3>
        <div className="sections-page__row-actions">
          <Checkbox
            label={t("academicGrading.examEntries.includeDrafts")}
            checked={includeDrafts}
            onChange={(event) => setIncludeDrafts(event.target.checked)}
          />
          <Button type="button" variant="secondary" loading={exporting} onClick={download}>
            {t("academicGrading.examEntries.export")}
          </Button>
        </div>
      </div>
      <div className="sections-page__row-actions">
        <Button
          type="button"
          variant="secondary"
          disabled={count("draft") === 0 || changeStatus.isPending}
          onClick={() => moveTo("entered", "draft")}
        >
          {t("academicGrading.examEntries.markEntered", { count: count("draft") })}
        </Button>
        <Button
          type="button"
          variant="tertiary"
          disabled={count("entered") === 0 || changeStatus.isPending}
          onClick={() => moveTo("withdrawn", "entered")}
        >
          {t("academicGrading.examEntries.withdraw", { count: count("entered") })}
        </Button>
        <Button
          type="button"
          variant="tertiary"
          disabled={count("withdrawn") === 0 || changeStatus.isPending}
          onClick={() => moveTo("entered", "withdrawn")}
        >
          {t("academicGrading.examEntries.reinstate", { count: count("withdrawn") })}
        </Button>
      </div>
      <Table caption={t("academicGrading.examEntries.entriesCaption", { name: title })} hideCaption>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>
              <input
                type="checkbox"
                aria-label={t("academicGrading.examEntries.selectAll")}
                checked={entries.length > 0 && selected.size === entries.length}
                disabled={entries.length === 0}
                onChange={(event) =>
                  setSelected(
                    event.target.checked ? new Set(entries.map((entry) => entry.id)) : new Set(),
                  )
                }
              />
            </Table.HeaderCell>
            <Table.HeaderCell>{t("academicGrading.examEntries.columns.student")}</Table.HeaderCell>
            <Table.HeaderCell>
              {t("academicGrading.examEntries.columns.candidateNumber")}
            </Table.HeaderCell>
            <Table.HeaderCell>{t("academicGrading.examEntries.columns.subjects")}</Table.HeaderCell>
            <Table.HeaderCell>{t("academicGrading.examEntries.columns.status")}</Table.HeaderCell>
            <Table.HeaderCell>{t("academicGrading.examEntries.columns.actions")}</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body columnCount={6} empty={t("academicGrading.examEntries.noEntries")}>
          {entries.map((entry) => (
            <Table.Row key={entry.id} aria-selected={selected.has(entry.id)}>
              <Table.Cell>
                <input
                  type="checkbox"
                  aria-label={t("academicGrading.examEntries.selectLabel", {
                    name: studentName(entry),
                  })}
                  checked={selected.has(entry.id)}
                  onChange={(event) => {
                    const next = new Set(selected);
                    if (event.target.checked) next.add(entry.id);
                    else next.delete(entry.id);
                    setSelected(next);
                  }}
                />
              </Table.Cell>
              <Table.Cell>
                <strong>{studentName(entry)}</strong>{" "}
                <span className="ag-muted">{entry.student.admission_number}</span>
                {entry.student.section_name ? (
                  <div className="ag-muted">
                    {t("principal.sections.sectionLabel", {
                      grade: entry.student.grade_level_name ?? "",
                      section: entry.student.section_name,
                    })}
                  </div>
                ) : null}
              </Table.Cell>
              <Table.Cell>{entry.candidate_number ?? "—"}</Table.Cell>
              <Table.Cell>
                {entry.subjects.length === 0
                  ? "—"
                  : entry.subjects
                      .map((subject) =>
                        [subject.name, subject.tier, subject.option_code]
                          .filter((part) => part)
                          .join(" · "),
                      )
                      .join(", ")}
                {entry.note ? <div className="ag-muted">{entry.note}</div> : null}
              </Table.Cell>
              <Table.Cell>
                <Badge tone={STATUS_TONES[entry.status] ?? "neutral"}>
                  {t(`academicGrading.examEntries.status.${entry.status}`)}
                </Badge>
                {entry.result_count > 0 ? (
                  <div className="ag-muted">
                    {t("academicGrading.examEntries.results", { count: entry.result_count })}
                  </div>
                ) : null}
              </Table.Cell>
              <Table.Cell>
                <div className="sections-page__row-actions">
                  <Button
                    type="button"
                    variant="secondary"
                    aria-label={t("academicGrading.examEntries.editEntryLabel", {
                      name: studentName(entry),
                    })}
                    onClick={() => setEditing(entry)}
                  >
                    {t("academicGrading.common.edit")}
                  </Button>
                  {entry.status === "draft" ? (
                    <Button
                      type="button"
                      variant="tertiary"
                      aria-label={t("academicGrading.examEntries.deleteEntryLabel", {
                        name: studentName(entry),
                      })}
                      onClick={() => setPendingDelete(entry)}
                    >
                      {t("academicGrading.common.remove")}
                    </Button>
                  ) : null}
                </div>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
      {editing ? (
        <EntryEditor
          entry={editing}
          perSubject={session.exam.per_subject}
          onClose={() => setEditing(null)}
        />
      ) : null}
      <ConfirmModal
        open={pendingDelete !== null}
        title={t("academicGrading.examEntries.deleteEntryTitle", {
          name: pendingDelete ? studentName(pendingDelete) : "",
        })}
        confirmLabel={t("academicGrading.common.remove")}
        submitting={remove.isPending}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() =>
          pendingDelete &&
          remove.mutate(pendingDelete.id, {
            onSuccess: () => {
              show({ variant: "success", title: t("academicGrading.examEntries.entryDeleted") });
              setPendingDelete(null);
            },
            onError: (error) => {
              show({
                variant: "error",
                title: t("academicGrading.examEntries.saveFailed"),
                description: problemMessage(error, t),
              });
              setPendingDelete(null);
            },
          })
        }
      />
    </section>
  );
}

/** An entry's candidate number, note and subjects. */
function EntryEditor({
  entry,
  perSubject,
  onClose,
}: {
  entry: ExamEntry;
  perSubject: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  const save = useUpdateExamEntry();
  const [candidateNumber, setCandidateNumber] = useState(entry.candidate_number ?? "");
  const [note, setNote] = useState(entry.note ?? "");
  const [subjects, setSubjects] = useState<SubjectChoice>(
    () =>
      new Map(
        entry.subjects.map((subject) => [
          subject.subject_id,
          { tier: subject.tier ?? "", optionCode: subject.option_code ?? "" },
        ]),
      ),
  );
  const incomplete = perSubject && subjects.size === 0;
  const name = `${entry.student.first_name} ${entry.student.last_name}`;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (incomplete) return;
    save.mutate(
      {
        entryId: entry.id,
        body: {
          candidate_number: blankToNull(candidateNumber),
          note: blankToNull(note),
          subjects: perSubject ? subjectBodies(subjects) : [],
        },
      },
      {
        onSuccess: () => {
          show({ variant: "success", title: t("academicGrading.examEntries.entrySaved") });
          onClose();
        },
      },
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="wide"
      title={t("academicGrading.examEntries.editEntryTitle", { name })}
    >
      <form onSubmit={submit} noValidate>
        <Modal.Body>
          <Input
            label={t("academicGrading.examEntries.candidateNumber")}
            value={candidateNumber}
            maxLength={20}
            onChange={(event) => setCandidateNumber(event.target.value)}
          />
          {perSubject ? (
            <SubjectPicker
              legend={t("academicGrading.examEntries.subjects")}
              value={subjects}
              onChange={setSubjects}
            />
          ) : null}
          <TextArea label={t("academicGrading.examEntries.note")} value={note} onChange={setNote} />
          {save.isError ? (
            <p className="ag-error" role="alert">
              {isProblem(save.error, ERROR_CODES.CONFLICT_DUPLICATE_ENTRY)
                ? t("academicGrading.examEntries.duplicateNumber")
                : problemMessage(save.error, t)}
            </p>
          ) : null}
        </Modal.Body>
        <Modal.Footer>
          <Button type="button" variant="tertiary" onClick={onClose}>
            {t("academicGrading.common.cancel")}
          </Button>
          <Button type="submit" loading={save.isPending} disabled={incomplete}>
            {t("academicGrading.examEntries.saveEntry")}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
