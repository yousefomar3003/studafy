import { Button, Modal } from "@studafy/ui";
import { useId, useState } from "react";

import { useFormatters, useLocale, useTranslation } from "../../../lib/i18n";

import { problemMessage } from "./errors";

import type { ClassRank, DocumentClassRank, GradingStatus, SubjectSource } from "./queries";
import type { FormEvent, ReactNode } from "react";

export type BadgeTone = "neutral" | "info" | "success" | "warning" | "danger" | "override";

export function Badge({ tone, children }: { tone: BadgeTone; children: ReactNode }) {
  return <span className={`ag-badge ag-badge--${tone}`}>{children}</span>;
}

const SOURCE_TONE: Record<SubjectSource, BadgeTone> = {
  inherited: "info",
  override: "override",
  section_only: "success",
  excluded: "neutral",
};

/**
 * Where a section's subject comes from. Inherited and overridden subjects must never look alike:
 * an inherited one follows every change to the grade default, an override does not.
 */
export function SourceBadge({ source }: { source: SubjectSource }) {
  const { t } = useTranslation();
  // eslint-disable-next-line security/detect-object-injection -- `source` is the closed SubjectSource union
  return <Badge tone={SOURCE_TONE[source]}>{t(`academicGrading.source.${source}`)}</Badge>;
}

const STATUS_TONE: Record<GradingStatus, BadgeTone> = {
  draft: "warning",
  active: "success",
  finalized: "info",
  archived: "neutral",
};

export function YearStatusBadge({ status }: { status: GradingStatus }) {
  const { t } = useTranslation();
  // eslint-disable-next-line security/detect-object-injection -- `status` is the closed GradingStatus union
  return <Badge tone={STATUS_TONE[status]}>{t(`academicGrading.status.${status}`)}</Badge>;
}

export function SeverityBadge({ severity }: { severity: "error" | "warning" }) {
  const { t } = useTranslation();
  return (
    <Badge tone={severity === "error" ? "danger" : "warning"}>
      {t(`academicGrading.severity.${severity}`)}
    </Badge>
  );
}

/** Loading / failed / empty line for a block whose data comes from one query. */
export function QueryState({
  isPending,
  error,
  empty,
  emptyText,
  children,
}: {
  isPending: boolean;
  error: unknown;
  empty?: boolean;
  emptyText?: string;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  if (isPending) {
    return (
      <p className="ag-muted" role="status">
        {t("academicGrading.common.loading")}
      </p>
    );
  }
  if (error) {
    return (
      <p className="ag-error" role="alert">
        {problemMessage(error, t)}
      </p>
    );
  }
  if (empty) return <p className="ag-muted">{emptyText}</p>;
  return <>{children}</>;
}

/** A percentage the API computed, shown as-is (never recomputed here). */
export function Percent({ value }: { value: number | null | undefined }) {
  const { formatNumber } = useFormatters();
  if (value === null || value === undefined) return <>—</>;
  return <>{formatNumber(value / 100, { style: "percent", maximumFractionDigits: 2 })}</>;
}

/** The slider's range for a subject's weight; the number box beside it takes any value up to 100. */
export const WEIGHT_SLIDER = { min: 0.5, max: 10, step: 0.5 } as const;

/**
 * A subject's weight in the overall average: a slider to drag (0.5 to 10 in halves) and a number
 * box beside it for an exact or larger value. Both edit the same text value, so a typed 12 is kept
 * and the slider rests at its end.
 */
export function WeightSlider({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const id = useId();
  const numeric = Number(value);
  const known = value.trim() !== "" && Number.isFinite(numeric);
  const position = known ? Math.min(WEIGHT_SLIDER.max, Math.max(WEIGHT_SLIDER.min, numeric)) : 1;
  const spoken = known
    ? t("academicGrading.editor.averageWeightValue", {
        value: formatNumber(numeric, { maximumFractionDigits: 2 }),
      })
    : "—";
  return (
    <div className="ag-weight">
      <label className="sf-field__label" htmlFor={`${id}-range`}>
        {t("academicGrading.editor.averageWeight")}
      </label>
      <div className="ag-weight__controls">
        <input
          id={`${id}-range`}
          className="ag-weight__range"
          type="range"
          min={WEIGHT_SLIDER.min}
          max={WEIGHT_SLIDER.max}
          step={WEIGHT_SLIDER.step}
          value={position}
          aria-valuetext={spoken}
          aria-describedby={`${id}-help`}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
        <input
          id={`${id}-number`}
          className="ag-weight__number"
          type="number"
          inputMode="decimal"
          min={0}
          max={100}
          step="any"
          value={value}
          aria-label={t("academicGrading.editor.averageWeightExact")}
          aria-describedby={`${id}-help`}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
      <p id={`${id}-help`} className="ag-muted ag-weight__help">
        <output htmlFor={`${id}-range ${id}-number`}>{spoken}</output>
        {" · "}
        {t("academicGrading.editor.averageWeightHelp")}
      </p>
    </div>
  );
}

/** A final result as the grade shows it (see the API's ResultDisplay). */
export interface ResultDisplayValue {
  format: "percentage" | "out_of" | "gpa";
  value: number | null;
  max: number;
}

/**
 * A final result in the grade's chosen format, with the percentage beside it: "16.5 / 20 (82.5%)",
 * "GPA 3.4 / 4 (85%)". Results with no format (or a percentage format) show the percentage alone.
 */
export function ResultValue({
  display,
  percentage,
  weightedGpa,
}: {
  display: ResultDisplayValue | null | undefined;
  percentage: number | null | undefined;
  /** The weighted GPA beside a GPA (Honors/AP boosts); absent on older results. */
  weightedGpa?: number | null;
}) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  if (!display || display.format === "percentage") return <Percent value={percentage} />;
  const value =
    display.value === null ? null : formatNumber(display.value, { maximumFractionDigits: 2 });
  const max = formatNumber(display.max, { maximumFractionDigits: 2 });
  const main =
    value === null
      ? display.format === "gpa"
        ? t("academicGrading.resultFormat.gpaUnavailable")
        : "—"
      : display.format === "gpa"
        ? t("academicGrading.resultFormat.gpaValue", { value, max })
        : t("academicGrading.resultFormat.valueOutOf", { value, max });
  return (
    <>
      <bdi>{main}</bdi>
      {display.format === "gpa" && value !== null ? <WeightedGpa value={weightedGpa} /> : null}
      {percentage === null || percentage === undefined ? null : (
        <>
          {" "}
          <small className="ag-result-percentage">
            (<Percent value={percentage} />)
          </small>
        </>
      )}
    </>
  );
}

/** " (weighted 4.1)" after a GPA, when there is a weighted GPA; nothing otherwise. */
export function WeightedGpa({ value }: { value: number | null | undefined }) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  if (value === null || value === undefined) return null;
  return (
    <>
      {" "}
      <small className="ag-result-weighted">
        <bdi>
          {t("academicGrading.credits.weighted", {
            value: formatNumber(value, { maximumFractionDigits: 2 }),
          })}
        </bdi>
      </small>
    </>
  );
}

/** A subject's course level ("Honors", "AP", "HL") as a small badge after its name. */
export function CourseLevel({ level }: { level: string | null | undefined }) {
  if (!level) return null;
  return (
    <>
      {" "}
      <span className="ag-course-level">
        <bdi>{level}</bdi>
      </span>
    </>
  );
}

type OrdinalCategory = "one" | "two" | "few" | "other";

/** "3rd" in English, "3" in Arabic: the place as the locale says it. */
export function useOrdinal(): (n: number) => string {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const { formatNumber } = useFormatters();
  let rules: Intl.PluralRules | null = null;
  try {
    rules = new Intl.PluralRules(locale, { type: "ordinal" });
  } catch {
    rules = null;
  }
  return (n) => {
    const category = rules?.select(n) ?? "other";
    const key: OrdinalCategory =
      category === "one" || category === "two" || category === "few" ? category : "other";
    return t(`academicGrading.rank.ordinal.${key}`, { n: formatNumber(n) });
  };
}

/**
 * A result's class rank: "3rd of 120 · 84th percentile", "Not ranked" for an incomplete result, or
 * "Rank pending" while a grade-wide rank waits for every section. Nothing without a rank.
 */
export function ClassRankLabel({ rank }: { rank: ClassRank | null | undefined }) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const ordinal = useOrdinal();
  if (!rank) return null;
  if (rank.status === "pending") {
    return (
      <span title={t("academicGrading.rank.pendingHelp")}>{t("academicGrading.rank.pending")}</span>
    );
  }
  if (rank.status !== "ranked" || rank.rank === null || rank.cohort_size === null) {
    return (
      <span title={t("academicGrading.rank.notRankedHelp")}>
        {t("academicGrading.rank.notRanked")}
      </span>
    );
  }
  return (
    <>
      <bdi>
        {t("academicGrading.rank.place", {
          place: ordinal(rank.rank),
          cohort: formatNumber(rank.cohort_size),
        })}
      </bdi>
      {rank.percentile === null ? null : (
        <div className="ag-muted">
          {t("academicGrading.rank.percentile", { place: ordinal(rank.percentile) })}
        </div>
      )}
    </>
  );
}

/**
 * The rank an issued certificate, report card or transcript kept, as a fact row; nothing when it
 * has none (documents issued before class ranks, or without a visible rank).
 */
export function DocumentRankFact({ rank }: { rank: DocumentClassRank | null | undefined }) {
  const { t } = useTranslation();
  if (!rank) return null;
  return (
    <div>
      <dt>{t("academicGrading.rank.column")}</dt>
      <dd>
        <ClassRankLabel rank={{ ...rank, status: "ranked" }} />
      </dd>
    </div>
  );
}

/** "3 of 4 credits earned"; nothing when the result carries no credits. */
export function CreditsEarned({
  attempted,
  earned,
}: {
  attempted: number | null | undefined;
  earned: number | null | undefined;
}) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  if (attempted === null || attempted === undefined) return null;
  return (
    <bdi>
      {t("academicGrading.credits.earnedOf", {
        earned: formatNumber(earned ?? 0, { maximumFractionDigits: 2 }),
        attempted: formatNumber(attempted, { maximumFractionDigits: 2 }),
      })}
    </bdi>
  );
}

export function Num({ value }: { value: number | null | undefined }) {
  const { formatNumber } = useFormatters();
  if (value === null || value === undefined) return <>—</>;
  return <>{formatNumber(value, { maximumFractionDigits: 2 })}</>;
}

export function DateTime({ value }: { value: string | null | undefined }) {
  const { formatDate } = useFormatters();
  if (!value) return <>—</>;
  return <>{formatDate(new Date(value), { dateStyle: "medium", timeStyle: "short" })}</>;
}

/** A multi-line text field with `@studafy/ui`'s Input chrome (the design system has no Textarea). */
export function TextArea({
  label,
  value,
  onChange,
  required = false,
  error,
  rows = 3,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  error?: string;
  rows?: number;
  disabled?: boolean;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div className="sf-field">
      <label className="sf-field__label" htmlFor={id}>
        {label}
        {required ? (
          <span className="sf-field__required" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>
      <div className="sf-input ag-textarea">
        <textarea
          id={id}
          className="sf-input__control"
          rows={rows}
          required={required}
          disabled={disabled}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
        />
      </div>
      {error ? (
        <p className="sf-field__error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A confirmation that needs a written reason (returning a mark sheet, reissuing or revoking a
 * certificate). Remount it per target (`key`) so a previous reason never carries over.
 */
export function ReasonModal({
  open,
  title,
  description,
  confirmLabel,
  submitting,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel: string;
  submitting: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const missing = touched && reason.trim() === "";

  function submit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (reason.trim() === "") return;
    onConfirm(reason.trim());
  }

  return (
    <Modal open={open} onClose={onCancel} title={title} description={description}>
      <form onSubmit={submit} noValidate>
        <Modal.Body>
          <TextArea
            label={t("academicGrading.common.reason")}
            value={reason}
            onChange={setReason}
            required
            error={missing ? t("academicGrading.common.reasonRequired") : undefined}
          />
        </Modal.Body>
        <Modal.Footer>
          <Button type="button" variant="tertiary" onClick={onCancel}>
            {t("academicGrading.common.cancel")}
          </Button>
          <Button type="submit" loading={submitting}>
            {confirmLabel}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}

/**
 * A yes/no confirmation for a consequential action. With `blockedReason`, the action cannot happen
 * right now: the dialog explains why and offers only Close.
 */
export function ConfirmModal({
  open,
  title,
  description,
  confirmLabel,
  submitting,
  onCancel,
  onConfirm,
  children,
  confirmDisabled,
  blockedReason,
}: {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel: string;
  submitting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  children?: ReactNode;
  confirmDisabled?: boolean;
  blockedReason?: string;
}) {
  const { t } = useTranslation();
  if (blockedReason) {
    return (
      <Modal open={open} onClose={onCancel} title={title}>
        <Modal.Body>
          <p>{blockedReason}</p>
        </Modal.Body>
        <Modal.Footer>
          <Button type="button" onClick={onCancel}>
            {t("academicGrading.common.close")}
          </Button>
        </Modal.Footer>
      </Modal>
    );
  }
  return (
    <Modal open={open} onClose={onCancel} title={title} description={description}>
      {children ? <Modal.Body>{children}</Modal.Body> : null}
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={onCancel}>
          {t("academicGrading.common.cancel")}
        </Button>
        <Button type="button" loading={submitting} disabled={confirmDisabled} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
