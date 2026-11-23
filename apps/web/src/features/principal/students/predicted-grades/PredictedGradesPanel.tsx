import { Button, Card, Input, Select, Table, useToast } from "@studafy/ui";
import { useState } from "react";

import { useTranslation } from "../../../../lib/i18n";
import { problemMessage } from "../../academic-setup/errors";

import { useSavePrediction, useStudentPredictedGrades } from "./queries";

import type { PredictedGradesYear, StudentPredictedGrade } from "./queries";

import "../../academic-setup/academic-setup.css";

const ANNUAL = "";

/**
 * A student's predicted grades on the principal's student page (000254): each academic year whose
 * grade records them, by subject and period. School leadership can set, change or remove one while
 * the year is open; teachers enter them from the app. Hidden when no year has any.
 */
export function PredictedGradesPanel({ studentId }: { studentId: string }) {
  const { t } = useTranslation();
  const predicted = useStudentPredictedGrades(studentId);
  const years = predicted.data?.years ?? [];

  if (predicted.isSuccess && years.length === 0) return null;

  return (
    <Card as="section" aria-labelledby="student-predicted-heading">
      <Card.Header>
        <h2 id="student-predicted-heading">{t("principal.students.predicted.heading")}</h2>
      </Card.Header>
      <Card.Body>
        {predicted.isPending ? (
          <p role="status">{t("principal.common.loading")}</p>
        ) : predicted.isError ? (
          <p role="alert">{t("principal.students.predicted.error")}</p>
        ) : (
          years.map((year) => (
            <PredictedYear key={year.academic_year_id} studentId={studentId} year={year} />
          ))
        )}
      </Card.Body>
    </Card>
  );
}

function PredictedYear({ studentId, year }: { studentId: string; year: PredictedGradesYear }) {
  const { t } = useTranslation();
  const { show } = useToast();
  const save = useSavePrediction(studentId);
  const [editing, setEditing] = useState<{
    subjectId: string;
    termId: string;
    label: string;
    note: string;
  } | null>(null);

  const period = (grade: Pick<StudentPredictedGrade, "term_name">) =>
    grade.term_name ?? t("principal.students.predicted.wholeYear");
  const subject = year.subjects.find((option) => option.subject_id === editing?.subjectId);

  function submit(gradeLabel: string | null, target = editing) {
    if (!target || !year.section_id) return;
    save.mutate(
      {
        sectionId: year.section_id,
        subjectId: target.subjectId,
        termId: target.termId === ANNUAL ? null : target.termId,
        gradeLabel,
        note: gradeLabel === null || target.note.trim() === "" ? null : target.note.trim(),
      },
      {
        onSuccess: () => {
          setEditing(null);
          show({
            variant: "success",
            title:
              gradeLabel === null
                ? t("principal.students.predicted.removed")
                : t("principal.students.predicted.saved"),
          });
        },
        onError: (error) =>
          show({
            variant: "error",
            title: t("principal.students.predicted.failed"),
            description: problemMessage(error, t),
          }),
      },
    );
  }

  const heading = year.section_name
    ? t("principal.students.predicted.yearOf", {
        year: year.academic_year_name,
        grade: year.grade_level_name,
        section: year.section_name,
      })
    : year.academic_year_name;

  return (
    <div className="ag-block">
      <h3>{heading}</h3>
      <p className="ag-muted">
        {year.enabled
          ? t(`principal.students.predicted.visibility.${year.visibility}`)
          : t("principal.students.predicted.disabled")}
      </p>
      <Table caption={heading} hideCaption>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>{t("principal.students.predicted.subject")}</Table.HeaderCell>
            <Table.HeaderCell>{t("principal.students.predicted.period")}</Table.HeaderCell>
            <Table.HeaderCell>{t("principal.students.predicted.grade")}</Table.HeaderCell>
            <Table.HeaderCell>{t("principal.students.predicted.note")}</Table.HeaderCell>
            {year.can_edit ? (
              <Table.HeaderCell>
                <span className="sf-visually-hidden">
                  {t("principal.students.predicted.actions")}
                </span>
              </Table.HeaderCell>
            ) : null}
          </Table.Row>
        </Table.Header>
        <Table.Body
          columnCount={year.can_edit ? 5 : 4}
          empty={t("principal.students.predicted.empty")}
        >
          {year.grades.map((grade) => (
            <Table.Row key={`${grade.subject_id}-${grade.term_id ?? "year"}`}>
              <Table.Cell>{grade.subject_name}</Table.Cell>
              <Table.Cell>{period(grade)}</Table.Cell>
              <Table.Cell>{grade.grade_label}</Table.Cell>
              <Table.Cell>{grade.note ?? "—"}</Table.Cell>
              {year.can_edit ? (
                <Table.Cell>
                  <div className="ag-actions">
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() =>
                        setEditing({
                          subjectId: grade.subject_id,
                          termId: grade.term_id ?? ANNUAL,
                          label: grade.grade_label,
                          note: grade.note ?? "",
                        })
                      }
                    >
                      {t("principal.students.predicted.edit")}
                    </Button>
                    <Button
                      type="button"
                      variant="tertiary"
                      loading={save.isPending}
                      aria-label={t("principal.students.predicted.removeLabel", {
                        subject: grade.subject_name,
                        period: period(grade),
                      })}
                      onClick={() =>
                        submit(null, {
                          subjectId: grade.subject_id,
                          termId: grade.term_id ?? ANNUAL,
                          label: "",
                          note: "",
                        })
                      }
                    >
                      {t("principal.students.predicted.remove")}
                    </Button>
                  </div>
                </Table.Cell>
              ) : null}
            </Table.Row>
          ))}
        </Table.Body>
      </Table>

      {year.can_edit && year.subjects.length > 0 ? (
        editing ? (
          <fieldset className="ag-fieldset">
            <legend>{t("principal.students.predicted.formHeading")}</legend>
            <div className="ag-grid">
              <Select
                label={t("principal.students.predicted.subject")}
                options={year.subjects.map((option) => ({
                  value: option.subject_id,
                  label: option.subject_name,
                }))}
                value={editing.subjectId}
                onChange={(subjectId) => setEditing({ ...editing, subjectId, label: "" })}
              />
              <Select
                label={t("principal.students.predicted.period")}
                options={[
                  { value: ANNUAL, label: t("principal.students.predicted.wholeYear") },
                  ...year.terms.map((term) => ({ value: term.term_id, label: term.term_name })),
                ]}
                value={editing.termId}
                onChange={(termId) => setEditing({ ...editing, termId })}
              />
              {subject && subject.labels.length > 0 ? (
                <Select
                  label={t("principal.students.predicted.grade")}
                  options={[
                    { value: "", label: t("principal.students.predicted.chooseGrade") },
                    ...subject.labels.map((label) => ({ value: label, label })),
                  ]}
                  value={editing.label}
                  onChange={(label) => setEditing({ ...editing, label })}
                />
              ) : (
                <Input
                  label={t("principal.students.predicted.grade")}
                  helperText={t("principal.students.predicted.freeLabelHelp")}
                  maxLength={40}
                  value={editing.label}
                  onChange={(event) => setEditing({ ...editing, label: event.target.value })}
                />
              )}
              <Input
                label={t("principal.students.predicted.note")}
                helperText={t("principal.students.predicted.noteHelp")}
                maxLength={1000}
                value={editing.note}
                onChange={(event) => setEditing({ ...editing, note: event.target.value })}
              />
            </div>
            <div className="ag-actions">
              <Button
                type="button"
                loading={save.isPending}
                disabled={editing.label.trim() === ""}
                onClick={() => submit(editing.label.trim())}
              >
                {t("principal.students.predicted.save")}
              </Button>
              <Button type="button" variant="secondary" onClick={() => setEditing(null)}>
                {t("principal.students.predicted.cancel")}
              </Button>
            </div>
          </fieldset>
        ) : (
          <div className="ag-actions">
            <Button
              type="button"
              variant="secondary"
              onClick={() =>
                setEditing({
                  subjectId: year.subjects[0]!.subject_id,
                  termId: ANNUAL,
                  label: "",
                  note: "",
                })
              }
            >
              {t("principal.students.predicted.add")}
            </Button>
          </div>
        )
      ) : null}
    </div>
  );
}
