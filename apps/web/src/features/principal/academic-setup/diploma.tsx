import { CORE_GRADES, DEFAULT_DIPLOMA_CONFIG } from "@studafy/grading-engine";
import { Button, Input, Select, Table, useToast } from "@studafy/ui";
import { useState } from "react";

import { useFormatters, useTranslation } from "../../../lib/i18n";

import { Badge } from "./components";
import { problemMessage } from "./errors";
import { useSaveDiplomaCore } from "./mutations";
import { useSectionDiplomaCore } from "./queries";

import type { BadgeTone } from "./components";
import type { SetupContext } from "./context";
import type { DiplomaConfig, DiplomaResult, SectionDiplomaCore } from "./queries";

/**
 * IB Diploma total (points_total grades, 000263): the grade's diploma rules in the program form,
 * the diploma outcome beside a result, and leadership's core grade entry for a section. Every
 * figure comes from the API; nothing is computed here.
 */

type CoreGrade = (typeof CORE_GRADES)[number];
type Condition = DiplomaConfig["conditions"][number];
type ConditionType = Condition["type"];

const CONDITION_TYPES: readonly ConditionType[] = [
  "min_total",
  "cas_complete",
  "core_grade_not",
  "max_subjects_at_or_below",
  "min_level_points",
];

/** The published IB matrix and conditions, as the API stores them by default. */
export function defaultDiplomaConfig(): DiplomaConfig {
  return {
    counted_subjects: DEFAULT_DIPLOMA_CONFIG.countedSubjects,
    core_matrix: DEFAULT_DIPLOMA_CONFIG.coreMatrix.map(({ tok, ee, points }) => ({
      tok,
      ee,
      points,
    })),
    conditions: DEFAULT_DIPLOMA_CONFIG.conditions.map((condition) => ({
      type: condition.type,
      value: condition.value,
      points: condition.points,
      grade: condition.grade,
      level: condition.level,
      best_of: condition.bestOf,
    })),
  };
}

const emptyCondition = (type: ConditionType): Condition => ({
  type,
  value: type === "cas_complete" || type === "core_grade_not" ? null : 0,
  points: type === "max_subjects_at_or_below" ? 1 : null,
  grade: type === "core_grade_not" ? "E" : null,
  level: type === "min_level_points" ? "HL" : null,
  best_of: null,
});

const numberOrNull = (text: string): number | null => (text.trim() === "" ? null : Number(text));

/** The grade's diploma rules: counted subjects, the TOK x EE matrix and the award conditions. */
export function DiplomaSettings({
  value,
  onChange,
  disabled,
}: {
  value: DiplomaConfig;
  onChange: (next: DiplomaConfig) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const cell = (tok: CoreGrade, ee: CoreGrade) =>
    value.core_matrix.find((candidate) => candidate.tok === tok && candidate.ee === ee)?.points ??
    0;
  const setCell = (tok: CoreGrade, ee: CoreGrade, points: number) =>
    onChange({
      ...value,
      core_matrix: CORE_GRADES.flatMap((rowGrade) =>
        CORE_GRADES.map((columnGrade) => ({
          tok: rowGrade,
          ee: columnGrade,
          points: rowGrade === tok && columnGrade === ee ? points : cell(rowGrade, columnGrade),
        })),
      ),
    });
  const setCondition = (index: number, next: Condition) =>
    onChange({
      ...value,
      conditions: value.conditions.map((condition, at) => (at === index ? next : condition)),
    });

  return (
    <div className="ag-diploma-settings">
      <h3 className="ag-subheading">{t("academicGrading.diploma.settings.heading")}</h3>
      <p className="ag-notice">{t("academicGrading.diploma.settings.disclaimer")}</p>
      <div className="ag-grid">
        <Input
          label={t("academicGrading.diploma.settings.countedSubjects")}
          helperText={t("academicGrading.diploma.settings.countedSubjectsHelp")}
          type="number"
          min={1}
          max={12}
          value={String(value.counted_subjects)}
          onChange={(event) => onChange({ ...value, counted_subjects: Number(event.target.value) })}
        />
      </div>
      <Table caption={t("academicGrading.diploma.settings.matrixCaption")}>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>
              {t("academicGrading.diploma.settings.matrixCorner")}
            </Table.HeaderCell>
            {CORE_GRADES.map((ee) => (
              <Table.HeaderCell key={ee}>
                {t("academicGrading.diploma.settings.eeColumn", { grade: ee })}
              </Table.HeaderCell>
            ))}
          </Table.Row>
        </Table.Header>
        <Table.Body columnCount={CORE_GRADES.length + 1}>
          {CORE_GRADES.map((tok) => (
            <Table.Row key={tok}>
              <Table.Cell>
                {t("academicGrading.diploma.settings.tokRow", { grade: tok })}
              </Table.Cell>
              {CORE_GRADES.map((ee) => (
                <Table.Cell key={ee}>
                  <Input
                    label={t("academicGrading.diploma.settings.cellLabel", { tok, ee })}
                    type="number"
                    min={0}
                    max={10}
                    value={String(cell(tok, ee))}
                    onChange={(event) => setCell(tok, ee, Number(event.target.value))}
                  />
                </Table.Cell>
              ))}
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
      <h4 className="ag-subheading">{t("academicGrading.diploma.settings.conditionsHeading")}</h4>
      <ul className="ag-list ag-diploma-conditions">
        {value.conditions.map((condition, index) => (
          <li key={index} className="ag-grid">
            <Select
              label={t("academicGrading.diploma.settings.conditionType")}
              options={CONDITION_TYPES.map((type) => ({
                value: type,
                label: t(`academicGrading.diploma.settings.types.${type}`),
              }))}
              value={condition.type}
              onChange={(type: ConditionType) => setCondition(index, emptyCondition(type))}
              disabled={disabled}
            />
            {condition.type === "cas_complete" || condition.type === "core_grade_not" ? null : (
              <Input
                label={t(`academicGrading.diploma.settings.value.${condition.type}`)}
                type="number"
                min={0}
                value={condition.value === null ? "" : String(condition.value)}
                onChange={(event) =>
                  setCondition(index, { ...condition, value: numberOrNull(event.target.value) })
                }
              />
            )}
            {condition.type === "max_subjects_at_or_below" ? (
              <Input
                label={t("academicGrading.diploma.settings.points")}
                type="number"
                min={0}
                value={condition.points === null ? "" : String(condition.points)}
                onChange={(event) =>
                  setCondition(index, { ...condition, points: numberOrNull(event.target.value) })
                }
              />
            ) : null}
            {condition.type === "core_grade_not" ? (
              <Select
                label={t("academicGrading.diploma.settings.grade")}
                options={CORE_GRADES.map((grade) => ({ value: grade, label: grade }))}
                value={condition.grade ?? "E"}
                onChange={(grade: CoreGrade) => setCondition(index, { ...condition, grade })}
                disabled={disabled}
              />
            ) : null}
            {condition.type === "min_level_points" ? (
              <>
                <Input
                  label={t("academicGrading.diploma.settings.level")}
                  maxLength={40}
                  value={condition.level ?? ""}
                  onChange={(event) =>
                    setCondition(index, { ...condition, level: event.target.value })
                  }
                />
                <Input
                  label={t("academicGrading.diploma.settings.bestOf")}
                  type="number"
                  min={1}
                  max={12}
                  value={condition.best_of === null ? "" : String(condition.best_of)}
                  onChange={(event) =>
                    setCondition(index, {
                      ...condition,
                      best_of: numberOrNull(event.target.value),
                    })
                  }
                />
              </>
            ) : null}
            {disabled ? null : (
              <Button
                type="button"
                variant="tertiary"
                onClick={() =>
                  onChange({
                    ...value,
                    conditions: value.conditions.filter((_, at) => at !== index),
                  })
                }
              >
                {t("academicGrading.diploma.settings.removeCondition")}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {disabled ? null : (
        <div className="ag-actions">
          <Button
            type="button"
            variant="secondary"
            onClick={() =>
              onChange({
                ...value,
                conditions: [...value.conditions, emptyCondition("min_total")],
              })
            }
          >
            {t("academicGrading.diploma.settings.addCondition")}
          </Button>
          <Button type="button" variant="tertiary" onClick={() => onChange(defaultDiplomaConfig())}>
            {t("academicGrading.diploma.settings.reset")}
          </Button>
        </div>
      )}
    </div>
  );
}

const STATUS_TONE: Record<DiplomaResult["status"], BadgeTone> = {
  awarded: "success",
  not_awarded: "danger",
  pending: "neutral",
};

/** "Core 3 · Diploma awarded", with the failing conditions or what is still missing. */
export function DiplomaSummary({ diploma }: { diploma: DiplomaResult | null | undefined }) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  if (!diploma) return <>—</>;
  const n = (value: number | null) =>
    value === null ? "—" : formatNumber(value, { maximumFractionDigits: 2 });
  return (
    <div className="ag-diploma-summary">
      <Badge tone={STATUS_TONE[diploma.status] ?? "neutral"}>
        {t(`academicGrading.diploma.status.${diploma.status}`, {
          defaultValue: diploma.status,
        })}
      </Badge>{" "}
      <span className="ag-muted">
        {t("academicGrading.diploma.corePoints", { points: n(diploma.core_points) })}
      </span>
      {diploma.failing_conditions.length > 0 ? (
        <ul className="ag-missing">
          {diploma.failing_conditions.map((condition, index) => (
            <li key={`${condition.code}-${index}`}>
              {t(`academicGrading.diploma.failing.${condition.code}`, {
                defaultValue: condition.code,
                required: n(condition.required),
                actual: n(condition.actual),
                points: n(condition.points),
                level: condition.level ?? "",
                grade: condition.grade ?? "",
                component: condition.component
                  ? t(`academicGrading.diploma.component.${condition.component}`)
                  : "",
              })}
            </li>
          ))}
        </ul>
      ) : diploma.status === "pending" ? (
        <ul className="ag-missing">
          {diploma.pending_reasons.map((reason) => (
            <li key={reason}>
              {t(`academicGrading.diploma.pending.${reason}`, { defaultValue: reason })}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

type CoreKind = "final" | "predicted";
interface CoreValues {
  tok_grade: CoreGrade | null;
  ee_grade: CoreGrade | null;
  cas: string;
}
const NONE = "";

function valuesOf(row: SectionDiplomaCore["students"][number], kind: CoreKind): CoreValues {
  const saved = row[kind];
  return {
    tok_grade: saved?.tok_grade ?? null,
    ee_grade: saved?.ee_grade ?? null,
    cas:
      saved?.cas_complete === true
        ? "complete"
        : saved?.cas_complete === false
          ? "incomplete"
          : NONE,
  };
}

/**
 * Leadership's core grade entry for a section of a points_total grade: final or predicted TOK and
 * Extended Essay grades and CAS for every student. Hidden for any other grade.
 */
export function DiplomaCorePanel({ ctx, sectionId }: { ctx: SetupContext; sectionId: string }) {
  const { t } = useTranslation();
  const core = useSectionDiplomaCore(sectionId);
  // Only a points_total grade has core grades: every other section shows nothing at all (not even
  // a loading state), as before the IB Diploma total existed.
  if (!core.data?.enabled) return null;
  return (
    <section className="ag-block" aria-labelledby="ag-diploma-core-heading">
      <h2 id="ag-diploma-core-heading">{t("academicGrading.diploma.core.heading")}</h2>
      <p className="ag-muted">{t("academicGrading.diploma.core.help")}</p>
      <CoreForm
        key={core.data.students
          .map((row) => `${row.final?.updated_at ?? ""}${row.predicted?.updated_at ?? ""}`)
          .join()}
        ctx={ctx}
        sectionId={sectionId}
        data={core.data}
      />
    </section>
  );
}

function CoreForm({
  ctx,
  sectionId,
  data,
}: {
  ctx: SetupContext;
  sectionId: string;
  data: SectionDiplomaCore;
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  const save = useSaveDiplomaCore();
  const [kind, setKind] = useState<CoreKind>("final");
  const [edits, setEdits] = useState<Record<string, CoreValues>>({});
  const readOnly =
    !data.editable || !ctx.can.finalize || (kind === "predicted" && !data.predicted_enabled);
  const current = (row: SectionDiplomaCore["students"][number]) =>
    edits[`${kind}|${row.student_id}`] ?? valuesOf(row, kind);
  const edit = (studentId: string, values: CoreValues) =>
    setEdits((previous) => ({ ...previous, [`${kind}|${studentId}`]: values }));
  const gradeOptions = [
    { value: NONE, label: t("academicGrading.diploma.core.none") },
    ...CORE_GRADES.map((grade) => ({ value: grade, label: grade })),
  ];
  const casOptions = [
    { value: NONE, label: t("academicGrading.diploma.core.none") },
    { value: "complete", label: t("academicGrading.diploma.core.casValues.complete") },
    { value: "incomplete", label: t("academicGrading.diploma.core.casValues.incomplete") },
  ];

  function submit() {
    const changed = data.students.filter((row) => edits[`${kind}|${row.student_id}`]);
    if (changed.length === 0) return;
    save.mutate(
      {
        sectionId,
        body: {
          kind,
          grades: changed.map((row) => {
            const values = current(row);
            return {
              student_id: row.student_id,
              tok_grade: values.tok_grade,
              ee_grade: values.ee_grade,
              cas_complete: values.cas === NONE ? null : values.cas === "complete",
            };
          }),
        },
      },
      {
        onSuccess: () => {
          setEdits({});
          show({ variant: "success", title: t("academicGrading.diploma.core.saved") });
        },
        onError: (error) =>
          show({
            variant: "error",
            title: t("academicGrading.diploma.core.failed"),
            description: problemMessage(error, t),
          }),
      },
    );
  }

  return (
    <>
      <div className="principal-school__filters">
        <Select
          label={t("academicGrading.diploma.core.kind")}
          options={(["final", "predicted"] as const).map((value) => ({
            value,
            label: t(`academicGrading.diploma.core.kinds.${value}`),
          }))}
          value={kind}
          onChange={setKind}
        />
      </div>
      {kind === "predicted" && !data.predicted_enabled ? (
        <p className="ag-notice">{t("academicGrading.diploma.core.predictedOff")}</p>
      ) : null}
      <Table caption={t("academicGrading.diploma.core.caption")} hideCaption>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>{t("academicGrading.diploma.core.student")}</Table.HeaderCell>
            <Table.HeaderCell>{t("academicGrading.diploma.core.tok")}</Table.HeaderCell>
            <Table.HeaderCell>{t("academicGrading.diploma.core.ee")}</Table.HeaderCell>
            <Table.HeaderCell>{t("academicGrading.diploma.core.cas")}</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body columnCount={4} empty={t("academicGrading.results.noStudents")}>
          {data.students.map((row) => {
            const values = current(row);
            const name = `${row.first_name} ${row.last_name}`;
            return (
              <Table.Row key={row.student_id}>
                <Table.Cell>
                  {name}
                  <div className="ag-muted">{row.admission_number}</div>
                </Table.Cell>
                <Table.Cell>
                  <Select
                    label={t("academicGrading.diploma.core.tok")}
                    options={gradeOptions}
                    value={values.tok_grade ?? NONE}
                    onChange={(grade: string) =>
                      edit(row.student_id, {
                        ...values,
                        tok_grade: grade === NONE ? null : (grade as CoreGrade),
                      })
                    }
                    disabled={readOnly}
                  />
                </Table.Cell>
                <Table.Cell>
                  <Select
                    label={t("academicGrading.diploma.core.ee")}
                    options={gradeOptions}
                    value={values.ee_grade ?? NONE}
                    onChange={(grade: string) =>
                      edit(row.student_id, {
                        ...values,
                        ee_grade: grade === NONE ? null : (grade as CoreGrade),
                      })
                    }
                    disabled={readOnly}
                  />
                </Table.Cell>
                <Table.Cell>
                  <Select
                    label={t("academicGrading.diploma.core.cas")}
                    options={casOptions}
                    value={values.cas}
                    onChange={(cas: string) => edit(row.student_id, { ...values, cas })}
                    disabled={readOnly}
                  />
                </Table.Cell>
              </Table.Row>
            );
          })}
        </Table.Body>
      </Table>
      {readOnly ? null : (
        <div className="ag-actions">
          <Button
            type="button"
            loading={save.isPending}
            disabled={!data.students.some((row) => edits[`${kind}|${row.student_id}`])}
            onClick={submit}
          >
            {t("academicGrading.diploma.core.save")}
          </Button>
        </div>
      )}
    </>
  );
}
