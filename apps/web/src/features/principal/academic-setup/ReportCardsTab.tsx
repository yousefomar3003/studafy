import { Button, Checkbox, Input, Select, Table, useToast } from "@studafy/ui";
import { useState } from "react";

import { useTranslation } from "../../../lib/i18n";
import { useTerms } from "../school/queries";
import { sectionDisplayName, useSections } from "../sections/queries";

import { QueryState } from "./components";
import { problemMessage } from "./errors";
import {
  conductCode,
  conductLabel,
  useReportCardSettings,
  useSaveStudentNotes,
  useSaveSubjectComments,
  useSectionReportNotes,
  useUpdateReportCardSettings,
} from "./report-cards";

import type { SetupContext } from "./context";
import type {
  ReportCardConductRating,
  ReportCardSettings,
  SaveStudentNoteItem,
  SectionReportNotes,
} from "./report-cards";

const ANNUAL = "annual";
const COMMENT_MAX = 1000;

type SectionKey =
  | "show_subject_comments"
  | "show_teacher_comment"
  | "show_principal_comment"
  | "show_attendance"
  | "show_conduct";

const SECTION_KEYS: readonly SectionKey[] = [
  "show_subject_comments",
  "show_teacher_comment",
  "show_principal_comment",
  "show_attendance",
  "show_conduct",
];

/**
 * Report cards: what the school's report cards and certificates show (leadership), and the
 * comments and conduct ratings teachers and the principal write for a section before its term or
 * year is finalized. Finalizing freezes the notes, with the attendance summary, into the results.
 */
export function ReportCardsTab({ ctx }: { ctx: SetupContext }) {
  return (
    <>
      <SettingsCard ctx={ctx} />
      <NotesEditor ctx={ctx} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function SettingsCard({ ctx }: { ctx: SetupContext }) {
  const { t } = useTranslation();
  const settings = useReportCardSettings();
  return (
    <section className="ag-block ag-card" aria-labelledby="ag-report-settings-heading">
      <h2 id="ag-report-settings-heading">{t("academicGrading.reportCards.settingsHeading")}</h2>
      <p className="ag-muted">{t("academicGrading.reportCards.settingsHelp")}</p>
      <QueryState isPending={settings.isPending} error={settings.error}>
        {settings.data ? (
          <SettingsForm
            key={JSON.stringify(settings.data)}
            settings={settings.data}
            canManage={ctx.can.manage}
          />
        ) : null}
      </QueryState>
    </section>
  );
}

function SettingsForm({
  settings,
  canManage,
}: {
  settings: ReportCardSettings;
  canManage: boolean;
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  const update = useUpdateReportCardSettings();
  const [sections, setSections] = useState<Record<SectionKey, boolean>>(() => ({
    show_subject_comments: settings.show_subject_comments,
    show_teacher_comment: settings.show_teacher_comment,
    show_principal_comment: settings.show_principal_comment,
    show_attendance: settings.show_attendance,
    show_conduct: settings.show_conduct,
  }));
  const [ratings, setRatings] = useState<ReportCardConductRating[]>(() => [
    ...settings.conduct_ratings,
  ]);
  const [touched, setTouched] = useState(false);
  const blank = ratings.some((rating) => rating.label.trim() === "");

  function setRating(index: number, patch: Partial<ReportCardConductRating>) {
    setRatings((prev) => prev.map((rating, i) => (i === index ? { ...rating, ...patch } : rating)));
  }

  function addRating() {
    setRatings((prev) => [
      ...prev,
      {
        code: conductCode(`rating ${prev.length + 1}`, new Set(prev.map((r) => r.code))),
        label: "",
        label_ar: null,
      },
    ]);
  }

  function save() {
    setTouched(true);
    if (blank || ratings.length === 0) return;
    update.mutate(
      {
        ...sections,
        conduct_ratings: ratings.map((rating) => ({
          code: rating.code,
          label: rating.label.trim(),
          label_ar: rating.label_ar?.trim() ? rating.label_ar.trim() : null,
        })),
      },
      {
        onSuccess: () =>
          show({ variant: "success", title: t("academicGrading.reportCards.settingsSaved") }),
        onError: (error) =>
          show({
            variant: "error",
            title: t("academicGrading.reportCards.saveFailed"),
            description: problemMessage(error, t),
          }),
      },
    );
  }

  return (
    <div className="ag-form">
      <fieldset className="ag-fieldset">
        <legend>{t("academicGrading.reportCards.sectionsLegend")}</legend>
        {SECTION_KEYS.map((key) => (
          <Checkbox
            key={key}
            label={t(`academicGrading.reportCards.sections.${key}`)}
            checked={sections[key]}
            disabled={!canManage}
            onChange={(event) => setSections((prev) => ({ ...prev, [key]: event.target.checked }))}
          />
        ))}
      </fieldset>

      <fieldset className="ag-fieldset">
        <legend>{t("academicGrading.reportCards.conductLegend")}</legend>
        <p className="ag-muted">{t("academicGrading.reportCards.conductHelp")}</p>
        <ol className="ag-conduct-list">
          {ratings.map((rating, index) => (
            <li key={rating.code} className="ag-grid ag-grid--dense">
              <Input
                label={t("academicGrading.reportCards.conductLabel", { n: index + 1 })}
                value={rating.label}
                maxLength={60}
                disabled={!canManage}
                error={
                  touched && rating.label.trim() === ""
                    ? t("academicGrading.reportCards.conductLabelRequired")
                    : undefined
                }
                onChange={(event) => setRating(index, { label: event.target.value })}
              />
              <Input
                label={t("academicGrading.reportCards.conductLabelAr", { n: index + 1 })}
                value={rating.label_ar ?? ""}
                maxLength={60}
                dir="rtl"
                lang="ar"
                disabled={!canManage}
                onChange={(event) => setRating(index, { label_ar: event.target.value })}
              />
              {canManage ? (
                <Button
                  type="button"
                  variant="tertiary"
                  disabled={ratings.length <= 1}
                  aria-label={t("academicGrading.reportCards.removeRating", {
                    label: rating.label || index + 1,
                  })}
                  onClick={() => setRatings((prev) => prev.filter((_, i) => i !== index))}
                >
                  {t("academicGrading.common.remove")}
                </Button>
              ) : null}
            </li>
          ))}
        </ol>
        {canManage ? (
          <Button
            type="button"
            variant="secondary"
            disabled={ratings.length >= 12}
            onClick={addRating}
          >
            {t("academicGrading.reportCards.addRating")}
          </Button>
        ) : null}
      </fieldset>

      {canManage ? (
        <div>
          <Button type="button" loading={update.isPending} onClick={save}>
            {t("academicGrading.reportCards.saveSettings")}
          </Button>
        </div>
      ) : (
        <p className="ag-muted">{t("academicGrading.reportCards.readOnlySettings")}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Notes for a section and period
// ---------------------------------------------------------------------------

function NotesEditor({ ctx }: { ctx: SetupContext }) {
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
    <section className="ag-block" aria-labelledby="ag-report-notes-heading">
      <h2 id="ag-report-notes-heading">{t("academicGrading.reportCards.notesHeading")}</h2>
      <p className="ag-muted">{t("academicGrading.reportCards.notesHelp")}</p>
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
          <SectionNotes key={`${section.id}-${period}`} sectionId={section.id} termId={termId} />
        ) : null}
      </QueryState>
    </section>
  );
}

interface Draft {
  teacher_comment: string;
  principal_comment: string;
  conduct_code: string;
}

function SectionNotes({ sectionId, termId }: { sectionId: string; termId: string | null }) {
  const { t } = useTranslation();
  const notes = useSectionReportNotes(sectionId, termId);
  return (
    <QueryState isPending={notes.isPending} error={notes.error}>
      {notes.data ? (
        <NotesTable
          key={JSON.stringify(notes.data.students)}
          notes={notes.data}
          sectionId={sectionId}
          termId={termId}
          emptyText={t("academicGrading.results.noStudents")}
        />
      ) : null}
    </QueryState>
  );
}

function NotesTable({
  notes,
  sectionId,
  termId,
  emptyText,
}: {
  notes: SectionReportNotes;
  sectionId: string;
  termId: string | null;
  emptyText: string;
}) {
  const { t, i18n } = useTranslation();
  const { show } = useToast();
  const saveNotes = useSaveStudentNotes();
  const saveComments = useSaveSubjectComments();
  const { settings } = notes;
  const commentable = notes.subjects.filter((subject) => subject.can_comment);
  const [subjectId, setSubjectId] = useState<string | undefined>(
    (commentable[0] ?? notes.subjects[0])?.subject_id,
  );
  const subject = notes.subjects.find((s) => s.subject_id === subjectId);

  const initial = new Map<string, Draft>(
    notes.students.map((student) => [
      student.student_id,
      {
        teacher_comment: student.teacher_comment ?? "",
        principal_comment: student.principal_comment ?? "",
        conduct_code: student.conduct_code ?? "",
      },
    ]),
  );
  const initialComment = (studentId: string, forSubject: string | undefined) =>
    notes.students
      .find((s) => s.student_id === studentId)
      ?.subject_comments.find((c) => c.subject_id === forSubject)?.body ?? "";

  const [drafts, setDrafts] = useState(initial);
  const [comments, setComments] = useState<Record<string, Record<string, string>>>({});

  const commentFor = (studentId: string) =>
    comments[subjectId ?? ""]?.[studentId] ?? initialComment(studentId, subjectId);

  function setDraft(studentId: string, patch: Partial<Draft>) {
    setDrafts((prev) => {
      const next = new Map(prev);
      next.set(studentId, { ...prev.get(studentId)!, ...patch });
      return next;
    });
  }

  const changedNotes: SaveStudentNoteItem[] = notes.students.flatMap((student) => {
    const before = initial.get(student.student_id)!;
    const after = drafts.get(student.student_id)!;
    const item: { -readonly [K in keyof SaveStudentNoteItem]: SaveStudentNoteItem[K] } = {
      student_id: student.student_id,
    };
    if (after.teacher_comment !== before.teacher_comment) {
      item.teacher_comment = after.teacher_comment.trim() || null;
    }
    if (notes.can_edit_principal_comment && after.principal_comment !== before.principal_comment) {
      item.principal_comment = after.principal_comment.trim() || null;
    }
    if (after.conduct_code !== before.conduct_code) item.conduct_code = after.conduct_code || null;
    return Object.keys(item).length > 1 ? [item] : [];
  });
  const changedComments = Object.entries(comments).flatMap(([forSubject, byStudent]) =>
    Object.entries(byStudent)
      .filter(([studentId, value]) => value !== initialComment(studentId, forSubject))
      .map(([studentId, value]) => ({ subjectId: forSubject, studentId, value })),
  );
  const dirty = changedNotes.length > 0 || changedComments.length > 0;
  const saving = saveNotes.isPending || saveComments.isPending;

  async function save() {
    try {
      if (changedNotes.length > 0) {
        await saveNotes.mutateAsync({ sectionId, termId, students: changedNotes });
      }
      const bySubject = new Map<string, { student_id: string; comment: string | null }[]>();
      for (const change of changedComments) {
        const items = bySubject.get(change.subjectId) ?? [];
        items.push({ student_id: change.studentId, comment: change.value.trim() || null });
        bySubject.set(change.subjectId, items);
      }
      for (const [forSubject, items] of bySubject) {
        await saveComments.mutateAsync({
          sectionId,
          subjectId: forSubject,
          termId,
          comments: items,
        });
      }
      show({ variant: "success", title: t("academicGrading.reportCards.notesSaved") });
    } catch (error) {
      show({
        variant: "error",
        title: t("academicGrading.reportCards.saveFailed"),
        description: problemMessage(error, t),
      });
    }
  }

  const showSubject = settings.show_subject_comments && notes.subjects.length > 0;

  return (
    <>
      {notes.finalized ? (
        <p className="ag-notice ag-notice--info">{t("academicGrading.reportCards.finalized")}</p>
      ) : !notes.editable ? (
        <p className="ag-notice">{t("academicGrading.reportCards.notOpen")}</p>
      ) : null}
      {showSubject ? (
        <div className="principal-school__filters">
          <Select
            label={t("academicGrading.reportCards.subjectLabel")}
            options={notes.subjects.map((s) => ({ value: s.subject_id, label: s.subject_name }))}
            value={subjectId}
            onChange={setSubjectId}
          />
        </div>
      ) : null}
      <Table caption={t("academicGrading.reportCards.notesCaption")} hideCaption>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>{t("academicGrading.results.columns.student")}</Table.HeaderCell>
            {settings.show_conduct ? (
              <Table.HeaderCell>
                {t("academicGrading.reportCards.columns.conduct")}
              </Table.HeaderCell>
            ) : null}
            {settings.show_teacher_comment ? (
              <Table.HeaderCell>
                {t("academicGrading.reportCards.columns.teacherComment")}
              </Table.HeaderCell>
            ) : null}
            {settings.show_principal_comment ? (
              <Table.HeaderCell>
                {t("academicGrading.reportCards.columns.principalComment")}
              </Table.HeaderCell>
            ) : null}
            {showSubject ? (
              <Table.HeaderCell>
                {t("academicGrading.reportCards.columns.subjectComment", {
                  subject: subject?.subject_name ?? "",
                })}
              </Table.HeaderCell>
            ) : null}
          </Table.Row>
        </Table.Header>
        <Table.Body columnCount={5} empty={emptyText}>
          {notes.students.map((student) => {
            const name = `${student.first_name} ${student.last_name}`;
            const draft = drafts.get(student.student_id)!;
            return (
              <Table.Row key={student.student_id}>
                <Table.Cell>
                  {name}
                  <div className="ag-muted">{student.admission_number}</div>
                </Table.Cell>
                {settings.show_conduct ? (
                  <Table.Cell>
                    <select
                      className="ag-inline-select"
                      aria-label={t("academicGrading.reportCards.conductFor", { name })}
                      value={draft.conduct_code}
                      disabled={!notes.can_edit_class_notes}
                      onChange={(event) =>
                        setDraft(student.student_id, { conduct_code: event.target.value })
                      }
                    >
                      <option value="">{t("academicGrading.reportCards.noConduct")}</option>
                      {settings.conduct_ratings.map((rating) => (
                        <option key={rating.code} value={rating.code}>
                          {conductLabel(rating, i18n.language)}
                        </option>
                      ))}
                      {draft.conduct_code &&
                      !settings.conduct_ratings.some((r) => r.code === draft.conduct_code) ? (
                        <option value={draft.conduct_code}>{draft.conduct_code}</option>
                      ) : null}
                    </select>
                  </Table.Cell>
                ) : null}
                {settings.show_teacher_comment ? (
                  <Table.Cell>
                    <CommentBox
                      label={t("academicGrading.reportCards.teacherCommentFor", { name })}
                      value={draft.teacher_comment}
                      disabled={!notes.can_edit_class_notes}
                      onChange={(value) => setDraft(student.student_id, { teacher_comment: value })}
                    />
                  </Table.Cell>
                ) : null}
                {settings.show_principal_comment ? (
                  <Table.Cell>
                    <CommentBox
                      label={t("academicGrading.reportCards.principalCommentFor", { name })}
                      value={draft.principal_comment}
                      disabled={!notes.can_edit_principal_comment}
                      onChange={(value) =>
                        setDraft(student.student_id, { principal_comment: value })
                      }
                    />
                  </Table.Cell>
                ) : null}
                {showSubject ? (
                  <Table.Cell>
                    <CommentBox
                      label={t("academicGrading.reportCards.subjectCommentFor", {
                        name,
                        subject: subject?.subject_name ?? "",
                      })}
                      value={commentFor(student.student_id)}
                      disabled={!subject?.can_comment}
                      onChange={(value) =>
                        setComments((prev) => ({
                          ...prev,
                          [subjectId ?? ""]: {
                            ...prev[subjectId ?? ""],
                            [student.student_id]: value,
                          },
                        }))
                      }
                    />
                  </Table.Cell>
                ) : null}
              </Table.Row>
            );
          })}
        </Table.Body>
      </Table>
      {notes.editable ? (
        <div className="ag-head">
          <span className="ag-muted" role="status">
            {dirty ? t("academicGrading.reportCards.unsaved") : null}
          </span>
          <Button type="button" disabled={!dirty} loading={saving} onClick={() => void save()}>
            {t("academicGrading.reportCards.saveNotes")}
          </Button>
        </div>
      ) : null}
    </>
  );
}

function CommentBox({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <textarea
      className="ag-comment-box"
      aria-label={label}
      value={value}
      rows={2}
      maxLength={COMMENT_MAX}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
