import { Button, Checkbox, Input, Modal, Select, useToast } from "@studafy/ui";
import { useState } from "react";

import { useTranslation } from "../../../lib/i18n";
import { Badge } from "../academic-setup/components";
import { problemMessage } from "../academic-setup/errors";
import { useTerms } from "../school/queries";
import { useGradeLevels } from "../sections/queries";

import { EXAM_PERIOD_KINDS, useSaveExamPeriod } from "./queries";

import type { ExamPeriodInput, ExamPeriodKind, ExamPeriodSummary } from "./queries";
import type { FormEvent } from "react";

export interface YearRef {
  id: string;
  name: string;
  starts_on: string;
  ends_on: string;
}

export function PeriodStatusBadge({ status }: { status: "draft" | "published" }) {
  const { t } = useTranslation();
  return (
    <Badge tone={status === "published" ? "success" : "warning"}>
      {t(`examWeeks.status.${status}`)}
    </Badge>
  );
}

interface PeriodDraft {
  name: string;
  kind: ExamPeriodKind;
  termId: string | undefined;
  startsOn: string;
  endsOn: string;
  gradeLevelIds: string[];
}

/** The period's body as saved: status is kept as it is (published from the period's page). */
export function periodBody(
  yearId: string,
  draft: PeriodDraft,
  status: "draft" | "published",
): ExamPeriodInput {
  return {
    academic_year_id: yearId,
    term_id: draft.termId ?? null,
    name: draft.name.trim(),
    kind: draft.kind,
    starts_on: draft.startsOn,
    ends_on: draft.endsOn,
    grade_level_ids: draft.gradeLevelIds,
    status,
  };
}

export function draftOf(period: ExamPeriodSummary | null): PeriodDraft {
  return {
    name: period?.name ?? "",
    kind: period?.kind ?? "final",
    termId: period?.term?.id,
    startsOn: period?.starts_on ?? "",
    endsOn: period?.ends_on ?? "",
    gradeLevelIds: period?.grade_levels.map((grade) => grade.id) ?? [],
  };
}

export function PeriodFormModal({
  year,
  period,
  onClose,
}: {
  year: YearRef;
  period: ExamPeriodSummary | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  const terms = useTerms(year.id);
  const grades = useGradeLevels();
  const save = useSaveExamPeriod();
  const [draft, setDraft] = useState<PeriodDraft>(() => draftOf(period));
  const [error, setError] = useState<string | null>(null);

  const datesInvalid =
    draft.startsOn !== "" && draft.endsOn !== "" && draft.endsOn < draft.startsOn;
  const valid =
    draft.name.trim() !== "" &&
    draft.startsOn !== "" &&
    draft.endsOn !== "" &&
    !datesInvalid &&
    draft.gradeLevelIds.length > 0;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    setError(null);
    save.mutate(
      {
        periodId: period?.id ?? null,
        body: periodBody(year.id, draft, period?.status ?? "draft"),
      },
      {
        onSuccess: () => {
          show({ variant: "success", title: t("examWeeks.periods.saved") });
          onClose();
        },
        onError: (problem) => setError(problemMessage(problem, t)),
      },
    );
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={period ? t("examWeeks.periods.editTitle") : t("examWeeks.periods.addTitle")}
      size="wide"
    >
      <form className="ag-form" onSubmit={submit}>
        <Modal.Body>
          <div className="ag-form">
            <Input
              label={t("examWeeks.periods.fields.name")}
              value={draft.name}
              required
              maxLength={120}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
            <div className="ag-grid ag-grid--dense">
              <Select
                label={t("examWeeks.periods.fields.kind")}
                options={EXAM_PERIOD_KINDS.map((kind) => ({
                  value: kind,
                  label: t(`examWeeks.kinds.${kind}`),
                }))}
                value={draft.kind}
                onChange={(kind) => setDraft({ ...draft, kind })}
              />
              <Select
                label={t("examWeeks.periods.fields.term")}
                placeholder={t("examWeeks.periods.fields.wholeYear")}
                options={[
                  { value: "", label: t("examWeeks.periods.fields.wholeYear") },
                  ...(terms.data ?? []).map((term) => ({ value: term.id, label: term.name })),
                ]}
                value={draft.termId ?? ""}
                onChange={(termId) => setDraft({ ...draft, termId: termId || undefined })}
              />
              <Input
                type="date"
                label={t("examWeeks.periods.fields.startsOn")}
                value={draft.startsOn}
                min={year.starts_on}
                max={year.ends_on}
                required
                onChange={(event) => setDraft({ ...draft, startsOn: event.target.value })}
              />
              <Input
                type="date"
                label={t("examWeeks.periods.fields.endsOn")}
                value={draft.endsOn}
                min={draft.startsOn || year.starts_on}
                max={year.ends_on}
                required
                error={datesInvalid ? t("examWeeks.periods.datesInvalid") : undefined}
                onChange={(event) => setDraft({ ...draft, endsOn: event.target.value })}
              />
            </div>
            <fieldset className="ew-fieldset">
              <legend>{t("examWeeks.periods.fields.grades")}</legend>
              <div className="ag-checks">
                {(grades.data ?? []).map((grade) => (
                  <Checkbox
                    key={grade.id}
                    label={grade.name}
                    checked={draft.gradeLevelIds.includes(grade.id)}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        gradeLevelIds: event.target.checked
                          ? [...draft.gradeLevelIds, grade.id]
                          : draft.gradeLevelIds.filter((id) => id !== grade.id),
                      })
                    }
                  />
                ))}
              </div>
            </fieldset>
            {error ? (
              <p className="ag-error" role="alert">
                {error}
              </p>
            ) : null}
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Button type="button" variant="tertiary" onClick={onClose}>
            {t("examWeeks.common.cancel")}
          </Button>
          <Button type="submit" disabled={!valid || save.isPending}>
            {t("examWeeks.periods.save")}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
