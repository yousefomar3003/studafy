import { ApiError } from "@studafy/api-client";
import { Button, Input, Radio, RadioGroup, useToast } from "@studafy/ui";
import { useEffect, useRef, useState } from "react";

import { useTranslation } from "../../../lib/i18n";

import { ConfirmChangeDialog } from "./ConfirmChangeDialog";
import { useApplyExamStructure, useUpdateSchoolSettings } from "./mutations";
import { DEFAULT_EXAM_WEIGHTS, EXAM_STRUCTURE_PARTS, EXAM_STRUCTURES } from "./schema";
import { SettingsCard } from "./SettingsCard";

import type { ApplyExamStructureResult } from "./mutations";
import type { SchoolSettings } from "./queries";
import type { ExamPart, ExamStructure, ExamWeights } from "./schema";
import type { FormEvent } from "react";

export interface ExamStructureSectionProps {
  settings: SchoolSettings | undefined;
  loading: boolean;
}

/** Weights as typed, one field per part; "" while a field is being cleared. */
type WeightDraft = Partial<Record<ExamPart, string>>;

function toDraft(weights: ExamWeights): WeightDraft {
  return Object.fromEntries(Object.entries(weights).map(([part, value]) => [part, String(value)]));
}

/**
 * The school's exam system: each term is either midterm + final, or first period + second period +
 * final, plus quizzes and homework, each with the share of the term the admin gives it. Subjects are
 * set up from it — new ones in Academic Setup start from it, and "Apply to all subjects" rebuilds the
 * active year's subjects that have no marks yet, so teachers enter exactly these parts every term.
 */
export function ExamStructureSection({ settings, loading }: ExamStructureSectionProps) {
  const { t } = useTranslation();
  const { show } = useToast();
  const updateSettings = useUpdateSchoolSettings();
  const applyStructure = useApplyExamStructure();

  const [structure, setStructure] = useState<ExamStructure>("midterm");
  const [weights, setWeights] = useState<WeightDraft>(toDraft(DEFAULT_EXAM_WEIGHTS.midterm));
  const [confirmingApply, setConfirmingApply] = useState(false);
  const [applied, setApplied] = useState<ApplyExamStructureResult | null>(null);
  const hydrated = useRef(false);

  useEffect(() => {
    if (!hydrated.current && settings) {
      setStructure(settings.exam_structure);
      setWeights(toDraft(settings.exam_weights));
      hydrated.current = true;
    }
  }, [settings]);

  // eslint-disable-next-line security/detect-object-injection -- `structure` is a closed union
  const parts = EXAM_STRUCTURE_PARTS[structure];
  // eslint-disable-next-line security/detect-object-injection -- `part` comes from a closed list
  const numbers = parts.map((part) => Number(weights[part] ?? ""));
  const total = numbers.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
  const invalidPart = parts.find((part, index) => {
    // eslint-disable-next-line security/detect-object-injection -- index into a local array
    const value = numbers[index]!;
    // eslint-disable-next-line security/detect-object-injection -- closed list
    return (weights[part] ?? "") === "" || !(value >= 0 && value <= 100);
  });
  const totalOk = Math.abs(total - 100) < 0.001;
  const savedMatches =
    settings?.exam_structure === structure &&
    parts.every(
      // eslint-disable-next-line security/detect-object-injection -- closed list
      (part, index) => settings.exam_weights[part] === numbers[index],
    );

  function chooseStructure(next: ExamStructure) {
    setStructure(next);
    // Back to the saved weights when returning to the saved system, otherwise that system's defaults.
    setWeights(
      toDraft(
        settings?.exam_structure === next
          ? settings.exam_weights
          : // eslint-disable-next-line security/detect-object-injection -- closed union
            DEFAULT_EXAM_WEIGHTS[next],
      ),
    );
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (invalidPart || !totalOk) return;
    updateSettings.mutate(
      {
        exam_structure: structure,
        exam_weights: Object.fromEntries(
          // eslint-disable-next-line security/detect-object-injection -- index into a local array
          parts.map((part, index) => [part, numbers[index]!]),
        ),
      },
      {
        onSuccess: () =>
          show({ variant: "success", title: t("adminSchool.settings.exams.updated") }),
        onError: (error) =>
          show({
            variant: "error",
            title: t("adminSchool.settings.saveFailed"),
            description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
          }),
      },
    );
  }

  function handleApply() {
    applyStructure.mutate(undefined, {
      onSuccess: (result) => {
        setApplied(result);
        setConfirmingApply(false);
        show({
          variant: "success",
          title: t("adminSchool.settings.exams.applied", { count: result.updated.length }),
        });
      },
      onError: (error) => {
        setConfirmingApply(false);
        show({
          variant: "error",
          title: t("adminSchool.settings.exams.applyFailed"),
          description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
        });
      },
    });
  }

  const hasMarks = applied?.skipped.filter((row) => row.reason === "has_marks") ?? [];
  const otherSkips = applied?.skipped.filter((row) => row.reason !== "has_marks") ?? [];

  return (
    <>
      <SettingsCard
        title={t("adminSchool.settings.exams.title")}
        description={t("adminSchool.settings.exams.description")}
        onSubmit={handleSubmit}
        saving={updateSettings.isPending}
      >
        <RadioGroup
          label={t("adminSchool.settings.exams.systemLabel")}
          name="exam_structure"
          value={structure}
          onChange={(value) => chooseStructure(value as ExamStructure)}
          disabled={loading}
        >
          {EXAM_STRUCTURES.map((option) => (
            <Radio
              key={option}
              value={option}
              label={t(`adminSchool.settings.exams.systems.${option}`)}
            />
          ))}
        </RadioGroup>

        <fieldset className="exam-structure__weights" disabled={loading}>
          <legend className="sf-field__label">
            {t("adminSchool.settings.exams.weightsLabel")}
          </legend>
          <p className="settings-card__description">
            {t("adminSchool.settings.exams.weightsHelp")}
          </p>
          {parts.map((part) => (
            <Input
              key={part}
              label={t(`adminSchool.settings.exams.parts.${part}`)}
              type="number"
              min={0}
              max={100}
              // eslint-disable-next-line security/detect-object-injection -- closed list
              value={weights[part] ?? ""}
              onChange={(e) => setWeights((prev) => ({ ...prev, [part]: e.target.value }))}
              error={
                invalidPart === part ? t("adminSchool.settings.validation.percentRange") : undefined
              }
              required
            />
          ))}
          <p
            className={
              totalOk ? "exam-structure__total" : "exam-structure__total exam-structure__total--off"
            }
            role="status"
          >
            {t("adminSchool.settings.exams.total", { total: Math.round(total * 100) / 100 })}
          </p>
        </fieldset>

        <div className="exam-structure__apply">
          <p className="settings-card__description">
            {savedMatches
              ? t("adminSchool.settings.exams.applyHelp")
              : t("adminSchool.settings.exams.saveBeforeApply")}
          </p>
          <Button
            type="button"
            variant="secondary"
            disabled={loading || !savedMatches}
            onClick={() => setConfirmingApply(true)}
          >
            {t("adminSchool.settings.exams.apply")}
          </Button>
          {applied ? (
            <div className="exam-structure__result" role="status">
              <p>
                {t("adminSchool.settings.exams.resultUpdated", {
                  count: applied.updated.length,
                  year: applied.academic_year_name,
                })}
              </p>
              {hasMarks.length > 0 ? (
                <p>
                  {t("adminSchool.settings.exams.resultHasMarks", {
                    subjects: hasMarks.map((row) => row.subject_name).join(", "),
                  })}
                </p>
              ) : null}
              {otherSkips.length > 0 ? (
                <p>
                  {t("adminSchool.settings.exams.resultOther", {
                    subjects: otherSkips.map((row) => row.subject_name).join(", "),
                  })}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </SettingsCard>

      <ConfirmChangeDialog
        open={confirmingApply}
        title={t("adminSchool.settings.exams.confirmTitle")}
        confirmLabel={t("adminSchool.settings.exams.apply")}
        loading={applyStructure.isPending}
        onConfirm={handleApply}
        onClose={() => setConfirmingApply(false)}
      >
        <p>{t("adminSchool.settings.exams.confirmBody")}</p>
      </ConfirmChangeDialog>
    </>
  );
}
