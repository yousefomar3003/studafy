import { Button, Checkbox, Input, useToast } from "@studafy/ui";
import { useState } from "react";

import { useTranslation } from "../../../lib/i18n";

import { problemMessage } from "./errors";
import { useSaveGradeProgram } from "./mutations";

import type { SetupContext } from "./context";
import type { GradeProgram } from "./queries";

interface DescriptorRow {
  key: string;
  /** Saved descriptor id (marks that chose it stay attached), or null for a new one. */
  id: string | null;
  label: string;
  /** "" means no points. */
  points: string;
  notAchieved: boolean;
}

let sequence = 0;
const newKey = () => `descriptor-${(sequence += 1)}`;

/** The default scale offered in the school's language (the API seeds the same one). */
const DEFAULTS: Record<"en" | "ar", { label: string; points: number }[]> = {
  en: [
    { label: "Excellent", points: 4 },
    { label: "Very good", points: 3 },
    { label: "Good", points: 2 },
    { label: "Needs improvement", points: 1 },
  ],
  ar: [
    { label: "ممتاز", points: 4 },
    { label: "جيد جدًا", points: 3 },
    { label: "جيد", points: 2 },
    { label: "يحتاج إلى تحسين", points: 1 },
  ],
};

function rowsOf(program: GradeProgram): DescriptorRow[] {
  return program.descriptors.map((descriptor) => ({
    key: descriptor.id,
    id: descriptor.id,
    label: descriptor.label,
    points: descriptor.points === null ? "" : String(descriptor.points),
    notAchieved: descriptor.not_achieved,
  }));
}

/**
 * A grade's descriptor scale for descriptive subjects (kindergarten and early primary): the
 * descriptors teachers pick from, highest first, each with optional points and an optional
 * "not achieved" mark. Renaming keeps the marks that used a descriptor; a used one cannot be removed.
 */
export function DescriptorScaleForm({
  ctx,
  gradeLevelId,
  program,
}: {
  ctx: SetupContext;
  gradeLevelId: string;
  program: GradeProgram;
}) {
  const { t, i18n } = useTranslation();
  const { show } = useToast();
  const save = useSaveGradeProgram();
  const [rows, setRows] = useState<DescriptorRow[]>(() => rowsOf(program));
  const [error, setError] = useState<string | null>(null);
  const disabled = !ctx.can.manage || !ctx.configEditable;

  const patch = (key: string, changes: Partial<DescriptorRow>) =>
    setRows((prev) => prev.map((row) => (row.key === key ? { ...row, ...changes } : row)));
  const move = (index: number, by: -1 | 1) =>
    setRows((prev) => {
      const next = [...prev];
      const [row] = next.splice(index, 1);
      next.splice(index + by, 0, row!);
      return next;
    });

  function applyDefaults() {
    const defaults = i18n.language?.toLowerCase().startsWith("ar") ? DEFAULTS.ar : DEFAULTS.en;
    setRows(
      defaults.map((descriptor) => ({
        key: newKey(),
        id: null,
        label: descriptor.label,
        points: String(descriptor.points),
        notAchieved: false,
      })),
    );
  }

  function submit() {
    setError(null);
    if (rows.length === 1 || rows.some((row) => row.label.trim() === "")) {
      setError(t("academicGrading.descriptive.scaleInvalid"));
      return;
    }
    const withPoints = rows.filter((row) => row.points.trim() !== "").length;
    if (withPoints > 0 && withPoints < rows.length) {
      setError(t("academicGrading.issues.DESCRIPTOR_POINTS_PARTIAL"));
      return;
    }
    save.mutate(
      {
        yearId: ctx.year.id,
        gradeLevelId,
        body: {
          descriptors: rows.map((row) => ({
            ...(row.id ? { id: row.id } : {}),
            label: row.label.trim(),
            points: row.points.trim() === "" ? null : Number(row.points),
            not_achieved: row.notAchieved,
          })),
        },
      },
      {
        onSuccess: () =>
          show({ variant: "success", title: t("academicGrading.descriptive.scaleSaved") }),
        onError: (problem) => setError(problemMessage(problem, t)),
      },
    );
  }

  return (
    <section className="ag-block ag-card" aria-labelledby="ag-descriptors-heading">
      <h2 id="ag-descriptors-heading">{t("academicGrading.descriptive.scaleHeading")}</h2>
      <p className="ag-muted">{t("academicGrading.descriptive.scaleHelp")}</p>
      <fieldset className="ag-fieldset ag-fieldset--plain" disabled={disabled}>
        <legend className="sf-visually-hidden">
          {t("academicGrading.descriptive.scaleHeading")}
        </legend>
        {rows.length === 0 ? (
          <p className="ag-muted">{t("academicGrading.descriptive.scaleEmpty")}</p>
        ) : (
          <ol className="ag-assessments">
            {rows.map((row, index) => {
              const name =
                row.label.trim() || t("academicGrading.descriptive.descriptorN", { n: index + 1 });
              return (
                <li
                  key={row.key}
                  className="ag-assessment"
                  role="group"
                  aria-label={t("academicGrading.descriptive.descriptorGroup", { name })}
                >
                  <div className="ag-grid ag-grid--dense">
                    <Input
                      label={t("academicGrading.descriptive.label")}
                      value={row.label}
                      required
                      maxLength={60}
                      onChange={(event) => patch(row.key, { label: event.target.value })}
                    />
                    <Input
                      label={t("academicGrading.descriptive.pointsLabel")}
                      helperText={t("academicGrading.descriptive.pointsHelp")}
                      type="number"
                      min={0}
                      value={row.points}
                      onChange={(event) => patch(row.key, { points: event.target.value })}
                    />
                  </div>
                  <div className="ag-row__actions">
                    <Checkbox
                      label={t("academicGrading.descriptive.notAchieved")}
                      checked={row.notAchieved}
                      onChange={(event) => patch(row.key, { notAchieved: event.target.checked })}
                    />
                    <Button
                      type="button"
                      variant="tertiary"
                      disabled={index === 0}
                      aria-label={t("academicGrading.descriptive.moveUp", { name })}
                      onClick={() => move(index, -1)}
                    >
                      ↑
                    </Button>
                    <Button
                      type="button"
                      variant="tertiary"
                      disabled={index === rows.length - 1}
                      aria-label={t("academicGrading.descriptive.moveDown", { name })}
                      onClick={() => move(index, 1)}
                    >
                      ↓
                    </Button>
                    <Button
                      type="button"
                      variant="tertiary"
                      aria-label={t("academicGrading.descriptive.removeDescriptor", { name })}
                      onClick={() => setRows((prev) => prev.filter((r) => r.key !== row.key))}
                    >
                      {t("academicGrading.editor.remove")}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </fieldset>
      {error ? (
        <p className="ag-error" role="alert">
          {error}
        </p>
      ) : null}
      {disabled ? null : (
        <div className="ag-actions">
          {rows.length === 0 ? (
            <Button type="button" variant="secondary" onClick={applyDefaults}>
              {t("academicGrading.descriptive.useDefaults")}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            onClick={() =>
              setRows((prev) => [
                ...prev,
                { key: newKey(), id: null, label: "", points: "", notAchieved: false },
              ])
            }
          >
            {t("academicGrading.descriptive.addDescriptor")}
          </Button>
          <Button type="button" loading={save.isPending} onClick={submit}>
            {t("academicGrading.descriptive.saveScale")}
          </Button>
        </div>
      )}
    </section>
  );
}
