import { ApiError } from "@studafy/api-client";
import { Button, Card, Chip, Input, useToast } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import { useFormatters, useTranslation } from "../../lib/i18n";

import {
  calendarDay,
  displayValue,
  draftFor,
  fieldLabel,
  sameValue,
  valueFromDraft,
} from "./fields";
import {
  useAttachRecordDocument,
  useRemoveRecordDocument,
  useSaveRecordAnswers,
  useUpdateRecordDocument,
} from "./mutations";
import {
  fetchSubjectRecords,
  recordDocumentDownloadUrl,
  recordsQueryKey,
  revealRecordValue,
} from "./queries";
import { RecordFieldInput } from "./RecordFieldInput";

import "./records.css";

import type { RecordDraft } from "./fields";
import type {
  RecordAnswerInput,
  RecordEntry,
  RecordFieldDefinition,
  RecordSubject,
  RecordValue,
} from "./queries";
import type { FormEvent } from "react";

/** How long a revealed sensitive value stays on screen before it is masked again. */
export const REVEAL_DURATION_MS = 30_000;

const DOCUMENT_ACCEPT: Record<"standard" | "sensitive", string> = {
  standard: "application/pdf,image/jpeg,image/png,image/heic",
  sensitive: "application/pdf,image/jpeg,image/png",
};

export interface RecordsPanelProps {
  subject: RecordSubject;
  /** `studentRecord:update`: edit answers and manage documents. */
  canEdit: boolean;
  /** `studentRecord:readSensitive`: the Reveal button, and downloading a sensitive document. */
  canRevealSensitive: boolean;
}

function errorDetail(error: unknown): string | undefined {
  return error instanceof ApiError ? (error.detail ?? error.title) : undefined;
}

function answeredField(entry: RecordEntry): RecordFieldDefinition | null {
  // The generated type intersects the nullable ref oddly; at runtime it is a definition or null.
  return (entry.answered_field as RecordFieldDefinition | null) ?? null;
}

/**
 * One student's or parent's school-defined record: every field of the published form the caller
 * may see (the API has already narrowed by visibility and row scope), its answer, and the file
 * behind each document field. Sensitive answers arrive masked; a revealed value lives only in this
 * component's state — never in the query cache — and is masked again after
 * {@link REVEAL_DURATION_MS} or when the panel unmounts.
 */
export function RecordsPanel({ subject, canEdit, canRevealSensitive }: RecordsPanelProps) {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: recordsQueryKey(subject),
    queryFn: () => fetchSubjectRecords(subject),
  });
  const [editing, setEditing] = useState(false);
  const { revealed, reveal, hide } = useRevealedValues(subject);

  if (query.isPending) return <p role="status">{t("records.panel.loading")}</p>;
  if (query.isError) return <p role="alert">{t("records.panel.loadError")}</p>;

  const records = query.data;
  const current = records.entries.filter((entry) => !entry.archived);
  const archived = records.entries.filter((entry) => entry.archived);
  const editable = current.filter((entry) => entry.field.field_type !== "document");

  return (
    <Card as="section" aria-label={t("records.panel.title")}>
      <Card.Header>
        <div className="records-panel__header">
          <div>
            <h2>{t("records.panel.title")}</h2>
            <p className="records-panel__meta">{t("records.panel.description")}</p>
            {records.missing_required > 0 ? (
              <p className="records-panel__missing">
                {t("records.panel.missingCount", { count: records.missing_required })}
              </p>
            ) : null}
          </div>
          {canEdit && !editing && editable.length > 0 ? (
            <Button variant="tertiary" onClick={() => setEditing(true)}>
              {t("records.panel.edit")}
            </Button>
          ) : null}
        </div>
      </Card.Header>
      <Card.Body>
        {records.template_version === 0 ? (
          <p>{t("records.panel.notPublished")}</p>
        ) : records.entries.length === 0 ? (
          <p>{t("records.panel.nothingShared")}</p>
        ) : editing ? (
          <RecordsEditForm subject={subject} entries={editable} onDone={() => setEditing(false)} />
        ) : (
          <>
            <dl className="records-list">
              {current.map((entry) => (
                <RecordEntryRow
                  key={entry.field.id}
                  subject={subject}
                  entry={entry}
                  canEdit={canEdit}
                  canRevealSensitive={canRevealSensitive}
                  revealed={revealed.get(entry.field.id)}
                  onReveal={() => reveal(entry.field.id)}
                  onHide={() => hide(entry.field.id)}
                />
              ))}
            </dl>
            {archived.length > 0 ? (
              <section className="records-archived" aria-label={t("records.panel.archivedTitle")}>
                <h3>{t("records.panel.archivedTitle")}</h3>
                <p className="records-panel__meta">{t("records.panel.archivedDescription")}</p>
                <dl className="records-list">
                  {archived.map((entry) => (
                    <RecordEntryRow
                      key={entry.field.id}
                      subject={subject}
                      entry={entry}
                      canEdit={false}
                      canRevealSensitive={canRevealSensitive}
                      revealed={revealed.get(entry.field.id)}
                      onReveal={() => reveal(entry.field.id)}
                      onHide={() => hide(entry.field.id)}
                    />
                  ))}
                </dl>
              </section>
            ) : null}
          </>
        )}
      </Card.Body>
    </Card>
  );
}

/** Revealed sensitive values, keyed by field, each cleared after REVEAL_DURATION_MS. */
function useRevealedValues(subject: RecordSubject) {
  const { t } = useTranslation();
  const { show } = useToast();
  const [revealed, setRevealed] = useState<Map<string, RecordValue>>(() => new Map());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const hide = useCallback((fieldId: string) => {
    clearTimeout(timers.current.get(fieldId));
    timers.current.delete(fieldId);
    setRevealed((previous) => {
      const next = new Map(previous);
      next.delete(fieldId);
      return next;
    });
  }, []);

  const reveal = useCallback(
    async (fieldId: string) => {
      try {
        const value = await revealRecordValue(subject, fieldId);
        setRevealed((previous) => new Map(previous).set(fieldId, value));
        clearTimeout(timers.current.get(fieldId));
        timers.current.set(
          fieldId,
          setTimeout(() => hide(fieldId), REVEAL_DURATION_MS),
        );
      } catch (error) {
        show({
          variant: "error",
          title: t("records.sensitive.revealError"),
          description: errorDetail(error),
        });
      }
    },
    [subject, hide, show, t],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  return { revealed, reveal, hide };
}

interface RecordEntryRowProps {
  subject: RecordSubject;
  entry: RecordEntry;
  canEdit: boolean;
  canRevealSensitive: boolean;
  revealed: RecordValue | undefined;
  onReveal: () => void;
  onHide: () => void;
}

function RecordEntryRow({
  subject,
  entry,
  canEdit,
  canRevealSensitive,
  revealed,
  onReveal,
  onHide,
}: RecordEntryRowProps) {
  const { t, i18n } = useTranslation();
  const { formatDate } = useFormatters();
  const language = i18n.language;
  const field = entry.field;
  const label = fieldLabel(field, language);
  const sensitive = field.sensitivity === "sensitive";
  const older = answeredField(entry);
  const format = (value: RecordValue) =>
    displayValue(
      value,
      [field, older],
      language,
      { yes: t("records.panel.yes"), no: t("records.panel.no") },
      (day) => formatDate(calendarDay(day), { dateStyle: "medium" }),
    );

  let body;
  if (field.field_type === "document") {
    body = (
      <DocumentControls
        subject={subject}
        entry={entry}
        label={label}
        canEdit={canEdit}
        canDownload={!entry.document?.sensitive || canRevealSensitive}
      />
    );
  } else if (sensitive) {
    body =
      revealed !== undefined ? (
        <span className="records-value">
          <span>{format(revealed) || t("records.panel.notAnswered")}</span>
          <Button
            variant="tertiary"
            aria-label={t("records.sensitive.hideLabel", { label })}
            onClick={onHide}
          >
            {t("records.sensitive.hide")}
          </Button>
          <span className="records-panel__meta">{t("records.sensitive.revealNotice")}</span>
        </span>
      ) : (
        <span className="records-value">
          <span aria-label={entry.masked ? t("records.sensitive.masked") : undefined}>
            {entry.mask ?? t("records.panel.notAnswered")}
          </span>
          {entry.masked && canRevealSensitive ? (
            <Button
              variant="tertiary"
              aria-label={t("records.sensitive.revealLabel", { label })}
              onClick={onReveal}
            >
              {t("records.sensitive.reveal")}
            </Button>
          ) : null}
        </span>
      );
  } else {
    body = (
      <span>{entry.value === null ? t("records.panel.notAnswered") : format(entry.value)}</span>
    );
  }

  return (
    <div className="records-list__item" data-field-id={field.id}>
      <dt>
        {label}
        {sensitive ? <Chip variant="outlined">{t("records.sensitive.badge")}</Chip> : null}
        {entry.missing ? <Chip>{t("records.panel.missing")}</Chip> : null}
      </dt>
      <dd>
        {body}
        {older && !entry.archived ? (
          <p className="records-panel__meta">
            {t("records.panel.olderVersion", { label: fieldLabel(older, language) })}
          </p>
        ) : null}
      </dd>
    </div>
  );
}

interface DocumentControlsProps {
  subject: RecordSubject;
  entry: RecordEntry;
  label: string;
  canEdit: boolean;
  canDownload: boolean;
}

function DocumentControls({ subject, entry, label, canEdit, canDownload }: DocumentControlsProps) {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const { show } = useToast();
  const attach = useAttachRecordDocument(subject);
  const update = useUpdateRecordDocument(subject);
  const remove = useRemoveRecordDocument(subject);
  const fileInput = useRef<HTMLInputElement>(null);
  const document = entry.document;
  const hasFile = document !== null && document.status !== "missing";
  const sensitive = entry.field.sensitivity === "sensitive";
  const [expiresOn, setExpiresOn] = useState(document?.expires_on ?? "");
  const busy = attach.isPending || update.isPending || remove.isPending;

  useEffect(() => setExpiresOn(document?.expires_on ?? ""), [document?.expires_on]);

  const day = (value: string) => formatDate(calendarDay(value), { dateStyle: "medium" });
  const expiry =
    document?.expires_on && document.expiry_state !== "none"
      ? t(`records.document.${document.expiry_state}`, { date: day(document.expires_on) })
      : null;

  function onError(title: string) {
    return (error: unknown) => show({ variant: "error", title, description: errorDetail(error) });
  }

  function upload(file: File) {
    attach.mutate(
      {
        fieldId: entry.field.id,
        file,
        sensitive,
        expiresOn: entry.field.has_expiry && expiresOn ? expiresOn : null,
      },
      {
        onSuccess: () => show({ variant: "success", title: t("records.document.uploadedToast") }),
        onError: onError(t("records.document.uploadError")),
      },
    );
  }

  async function download() {
    try {
      const url = await recordDocumentDownloadUrl(subject, entry.field.id);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (error) {
      onError(t("records.document.downloadError"))(error);
    }
  }

  return (
    <div className="records-document">
      <p>
        <span data-status={document?.status ?? "missing"}>
          {t(`records.document.status.${document?.status ?? "missing"}`)}
        </span>
        {hasFile && document.file_name ? <> &middot; {document.file_name}</> : null}
        {expiry ? (
          <>
            {" "}
            &middot; <span data-expiry={document?.expiry_state}>{expiry}</span>
          </>
        ) : null}
      </p>
      {sensitive ? (
        <p className="records-panel__meta">{t("records.document.sensitiveNote")}</p>
      ) : null}
      <div className="records-document__actions">
        {hasFile && canDownload ? (
          <Button
            variant="tertiary"
            aria-label={t("records.document.downloadLabel", { label })}
            onClick={() => void download()}
          >
            {t("records.document.download")}
          </Button>
        ) : null}
        {canEdit ? (
          <>
            <input
              ref={fileInput}
              type="file"
              hidden
              accept={DOCUMENT_ACCEPT[sensitive ? "sensitive" : "standard"]}
              aria-label={t("records.document.fileLabel", { label })}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) upload(file);
              }}
            />
            <Button
              variant="secondary"
              loading={attach.isPending}
              disabled={busy}
              onClick={() => fileInput.current?.click()}
            >
              {hasFile ? t("records.document.replace") : t("records.document.upload")}
            </Button>
          </>
        ) : null}
        {canEdit && hasFile ? (
          <>
            <Button
              variant="tertiary"
              disabled={busy}
              onClick={() =>
                update.mutate(
                  {
                    fieldId: entry.field.id,
                    status: document.status === "verified" ? "uploaded" : "verified",
                  },
                  { onError: onError(t("records.document.actionError")) },
                )
              }
            >
              {document.status === "verified"
                ? t("records.document.unverify")
                : t("records.document.verify")}
            </Button>
            <Button
              variant="tertiary"
              disabled={busy}
              onClick={() =>
                remove.mutate(entry.field.id, {
                  onSuccess: () =>
                    show({ variant: "success", title: t("records.document.removedToast") }),
                  onError: onError(t("records.document.actionError")),
                })
              }
            >
              {t("records.document.remove")}
            </Button>
          </>
        ) : null}
      </div>
      {canEdit && entry.field.has_expiry ? (
        <div className="records-document__expiry">
          <Input
            label={t("records.document.expiresOnFor", { label })}
            type="date"
            value={expiresOn}
            onChange={(event) => setExpiresOn(event.target.value)}
          />
          {hasFile ? (
            <Button
              variant="tertiary"
              disabled={busy || expiresOn === (document.expires_on ?? "")}
              onClick={() =>
                update.mutate(
                  { fieldId: entry.field.id, expiresOn: expiresOn || null },
                  { onError: onError(t("records.document.actionError")) },
                )
              }
            >
              {t("records.document.saveExpiry")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

interface RecordsEditFormProps {
  subject: RecordSubject;
  entries: RecordEntry[];
  onDone: () => void;
}

/**
 * Edits every non-document field of the current form at once and sends only what changed. A
 * sensitive field starts empty — its value is never placed in an input — and is sent only when
 * something is typed into it.
 */
function RecordsEditForm({ subject, entries, onDone }: RecordsEditFormProps) {
  const { t } = useTranslation();
  const { show } = useToast();
  const save = useSaveRecordAnswers(subject);
  const [drafts, setDrafts] = useState<Record<string, RecordDraft>>(() =>
    Object.fromEntries(
      entries.map((entry) => [
        entry.field.id,
        entry.field.sensitivity === "sensitive"
          ? draftFor(entry.field, null)
          : draftFor(entry.field, entry.value),
      ]),
    ),
  );

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const answers: RecordAnswerInput[] = [];
    for (const entry of entries) {
      const next = valueFromDraft(entry.field, drafts[entry.field.id] ?? null);
      if (entry.field.sensitivity === "sensitive") {
        if (next !== null) answers.push({ field_id: entry.field.id, value: next });
      } else if (!sameValue(next, entry.value)) {
        answers.push({ field_id: entry.field.id, value: next });
      }
    }
    if (answers.length === 0) {
      show({ variant: "info", title: t("records.panel.noChanges") });
      onDone();
      return;
    }
    save.mutate(answers, {
      onSuccess: () => {
        show({ variant: "success", title: t("records.panel.savedToast") });
        onDone();
      },
      onError: (error) =>
        show({
          variant: "error",
          title: t("records.panel.saveError"),
          description: errorDetail(error),
        }),
    });
  }

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      aria-label={t("records.panel.edit")}
      className="records-form"
    >
      {entries.map((entry) => (
        <RecordFieldInput
          key={entry.field.id}
          field={entry.field}
          value={drafts[entry.field.id] ?? null}
          onChange={(value) => setDrafts((previous) => ({ ...previous, [entry.field.id]: value }))}
          hint={
            entry.field.sensitivity === "sensitive" && entry.masked
              ? t("records.sensitive.keepHint")
              : undefined
          }
        />
      ))}
      <div className="records-form__actions">
        <Button type="button" variant="tertiary" onClick={onDone}>
          {t("records.panel.cancel")}
        </Button>
        <Button type="submit" loading={save.isPending}>
          {t("records.panel.save")}
        </Button>
      </div>
    </form>
  );
}
