import { ApiError } from "@studafy/api-client";
import { Button, Input, Modal, Select, useToast } from "@studafy/ui";
import { useEffect, useState } from "react";

import { useTranslation } from "../../../lib/i18n";

import { useCreateTerm, useCreateYear, useUpdateTerm, useUpdateYear } from "./mutations";

import type { AcademicYear, Term } from "../../admin/timetable/queries";

/** Mirrors the API's year and term bodies: a 1–50 character code and a 1–200 character name. */
const MAX_CODE_LENGTH = 50;
const MAX_NAME_LENGTH = 200;

/** A term's status is the school's to set (a year's moves only by rollover). */
const TERM_STATUSES = ["planned", "active", "closed"] as const;

export type PeriodModalTarget =
  | { kind: "year"; year: AcademicYear | null }
  | { kind: "term"; yearId: string; term: Term | null; nextSequence: number };

export interface PeriodModalProps {
  /** `null` keeps the dialog closed. */
  target: PeriodModalTarget | null;
  onClose: () => void;
}

function apiErrorDescription(error: unknown): string | undefined {
  return error instanceof ApiError ? (error.detail ?? error.title) : undefined;
}

/** Adds or edits an academic year ("2026–2027") or one of its terms ("Term 2"). */
export function PeriodModal({ target, onClose }: PeriodModalProps) {
  const { t } = useTranslation();
  const { show } = useToast();
  const createYear = useCreateYear();
  const updateYear = useUpdateYear();
  const createTerm = useCreateTerm();
  const updateTerm = useUpdateTerm();
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [sequence, setSequence] = useState("1");
  const [status, setStatus] = useState<(typeof TERM_STATUSES)[number]>("planned");

  const existing = target?.kind === "year" ? target.year : (target?.term ?? null);
  const isTerm = target?.kind === "term";

  useEffect(() => {
    if (!target) return;
    setName(existing?.name ?? "");
    setCode(existing?.code ?? "");
    // The API sends these dates as midnight-UTC timestamps; a date input takes only `YYYY-MM-DD`.
    setStartsOn(existing?.starts_on.slice(0, 10) ?? "");
    setEndsOn(existing?.ends_on.slice(0, 10) ?? "");
    if (target.kind === "term") {
      setSequence(String(target.term?.sequence_number ?? target.nextSequence));
      const current = target.term?.status;
      setStatus(current === "active" || current === "closed" ? current : "planned");
    }
  }, [target, existing]);

  const parsedSequence = Number(sequence);
  const sequenceValid = Number.isInteger(parsedSequence) && parsedSequence >= 1;
  const datesValid = startsOn !== "" && endsOn !== "" && endsOn > startsOn;
  const canSubmit =
    name.trim() !== "" && code.trim() !== "" && datesValid && (!isTerm || sequenceValid);
  const saving = isTerm ? (existing ? updateTerm : createTerm) : existing ? updateYear : createYear;
  const prefix = isTerm ? "principal.years.termModal" : "principal.years.yearModal";

  function handleSubmit() {
    if (!target || !canSubmit) return;
    const fields = {
      name: name.trim(),
      code: code.trim(),
      starts_on: startsOn,
      ends_on: endsOn,
    };
    const onSuccess = () => {
      show({ variant: "success", title: t(existing ? `${prefix}.updated` : `${prefix}.created`) });
      onClose();
    };
    const onError = (error: unknown) =>
      show({
        variant: "error",
        title: t(`${prefix}.saveFailed`),
        description: apiErrorDescription(error),
      });

    if (target.kind === "year") {
      if (target.year) {
        updateYear.mutate({ yearId: target.year.id, body: fields }, { onSuccess, onError });
      } else {
        // A new year starts planned; it becomes the current one only by starting it (rollover).
        createYear.mutate({ ...fields, status: "planned" }, { onSuccess, onError });
      }
      return;
    }
    const termFields = { ...fields, sequence_number: parsedSequence, status };
    if (target.term) {
      updateTerm.mutate({ termId: target.term.id, body: termFields }, { onSuccess, onError });
    } else {
      createTerm.mutate({ ...termFields, academic_year_id: target.yearId }, { onSuccess, onError });
    }
  }

  return (
    <Modal
      open={target !== null}
      onClose={onClose}
      title={t(existing ? `${prefix}.editTitle` : `${prefix}.addTitle`)}
    >
      <Modal.Body>
        <div className="sections-form">
          <Input
            label={t(`${prefix}.name`)}
            value={name}
            required
            maxLength={MAX_NAME_LENGTH}
            placeholder={t(`${prefix}.namePlaceholder`)}
            onChange={(event) => setName(event.target.value)}
          />
          <Input
            label={t(`${prefix}.code`)}
            value={code}
            required
            maxLength={MAX_CODE_LENGTH}
            placeholder={t(`${prefix}.codePlaceholder`)}
            helperText={t(`${prefix}.codeHelper`)}
            onChange={(event) => setCode(event.target.value)}
          />
          <Input
            label={t("principal.years.startsOn")}
            type="date"
            value={startsOn}
            required
            onChange={(event) => setStartsOn(event.target.value)}
          />
          <Input
            label={t("principal.years.endsOn")}
            type="date"
            value={endsOn}
            min={startsOn || undefined}
            required
            onChange={(event) => setEndsOn(event.target.value)}
            error={
              startsOn !== "" && endsOn !== "" && endsOn <= startsOn
                ? t("principal.years.datesInvalid")
                : undefined
            }
          />
          {isTerm ? (
            <>
              <Input
                label={t("principal.years.termModal.sequence")}
                type="number"
                min={1}
                step={1}
                value={sequence}
                required
                helperText={t("principal.years.termModal.sequenceHelper")}
                onChange={(event) => setSequence(event.target.value)}
              />
              <Select
                label={t("principal.years.termModal.status")}
                options={TERM_STATUSES.map((value) => ({
                  value,
                  label: t(`principal.years.status.${value}`),
                }))}
                value={status}
                onChange={(value) => setStatus(value as (typeof TERM_STATUSES)[number])}
              />
            </>
          ) : null}
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={onClose}>
          {t("principal.common.cancel")}
        </Button>
        <Button
          type="button"
          loading={saving.isPending}
          disabled={!canSubmit}
          onClick={handleSubmit}
        >
          {t(existing ? `${prefix}.save` : `${prefix}.add`)}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
