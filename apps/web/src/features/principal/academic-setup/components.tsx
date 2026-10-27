import { Button, Modal } from "@studafy/ui";
import { useId, useState } from "react";

import { useFormatters, useTranslation } from "../../../lib/i18n";

import { problemMessage } from "./errors";

import type { GradingStatus, SubjectSource } from "./queries";
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

/** A yes/no confirmation for a consequential action. */
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
}) {
  const { t } = useTranslation();
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
