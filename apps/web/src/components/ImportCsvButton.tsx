import { Button, Modal, useToast } from "@studafy/ui";
import { useId, useRef, useState } from "react";

import { buildCsv, downloadCsv } from "../lib/csv";
import {
  buildImportTemplate,
  MAX_IMPORT_ROWS,
  prepareImport,
  runImport,
} from "../lib/data-transfer";
import { useTranslation } from "../lib/i18n";

import "./data-transfer.css";

import type {
  ImportIssue,
  ImportRowResult,
  ImportSpec,
  PrepareResult,
  PreparedRow,
} from "../lib/data-transfer";

export interface ImportCsvButtonProps<TRecord> {
  spec: ImportSpec<TRecord>;
  /** Dialog heading, e.g. "Import classes". */
  title: string;
  /** Called once after an import created at least one row — invalidate the list query here. */
  onImported: () => void;
  disabled?: boolean;
}

type Stage =
  | { kind: "pick" }
  | { kind: "invalidFile"; result: Extract<PrepareResult<unknown>, { ok: false }> }
  | { kind: "review"; fileName: string; rows: PreparedRow<unknown>[]; ignoredColumns: string[] }
  | { kind: "running"; total: number; done: number }
  | { kind: "done"; results: ImportRowResult[]; skipped: number; notAttempted: number };

/** Lines listed in the dialog before collapsing into "and N more" (the full list is downloadable). */
const VISIBLE_ISSUES = 8;

/**
 * "Import" button plus its dialog: download a template, pick a CSV, review per-row validation, then
 * create the valid rows through the entity's existing create endpoint. Rows with errors are never
 * sent; rows the server rejects are reported by line and downloadable as a CSV to fix and re-upload.
 */
export function ImportCsvButton<TRecord>({
  spec,
  title,
  onImported,
  disabled,
}: ImportCsvButtonProps<TRecord>) {
  const { t } = useTranslation();
  const { show } = useToast();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<Stage>({ kind: "pick" });

  const issueText = (issue: ImportIssue): string =>
    issue.code === "custom"
      ? (issue.message ?? "")
      : t(`dataTransfer.import.issues.${issue.code}`, {
          field: issue.field ?? "",
          ...issue.params,
        });

  const close = () => {
    if (stage.kind === "running") return;
    setOpen(false);
    setStage({ kind: "pick" });
  };

  const handleFile = async (file: File) => {
    const result = prepareImport(await file.text(), spec);
    if (result.ok) {
      setStage({
        kind: "review",
        fileName: file.name,
        rows: result.rows as PreparedRow<unknown>[],
        ignoredColumns: result.ignoredColumns,
      });
    } else {
      setStage({ kind: "invalidFile", result });
    }
    if (inputRef.current) inputRef.current.value = "";
  };

  const handleImport = async (rows: PreparedRow<unknown>[]) => {
    const valid = rows.filter((row) => row.record !== null);
    const controller = new AbortController();
    abortRef.current = controller;
    setStage({ kind: "running", total: valid.length, done: 0 });
    const results = await runImport(rows as PreparedRow<TRecord>[], spec.create, {
      signal: controller.signal,
      onProgress: (done) => setStage({ kind: "running", total: valid.length, done }),
    });
    abortRef.current = null;
    setStage({
      kind: "done",
      results,
      skipped: rows.length - valid.length,
      notAttempted: valid.length - results.length,
    });
    const created = results.filter((result) => result.ok).length;
    if (created > 0) {
      onImported();
      show({ variant: "success", title: t("dataTransfer.import.created", { count: created }) });
    }
  };

  const downloadIssueReport = (lines: { line: number; message: string }[]) => {
    downloadCsv(
      `${spec.templateName}-errors.csv`,
      buildCsv(
        [t("dataTransfer.import.reportLine"), t("dataTransfer.import.reportError")],
        lines.map((entry) => [entry.line, entry.message]),
      ),
    );
  };

  const renderIssueList = (lines: { line: number; message: string }[]) => (
    <>
      <ul className="data-transfer__issues">
        {lines.slice(0, VISIBLE_ISSUES).map((entry) => (
          <li key={entry.line}>
            <span className="data-transfer__line">
              {t("dataTransfer.import.line", { line: entry.line })}
            </span>{" "}
            {entry.message}
          </li>
        ))}
      </ul>
      {lines.length > VISIBLE_ISSUES ? (
        <p className="data-transfer__muted">
          {t("dataTransfer.import.moreIssues", { count: lines.length - VISIBLE_ISSUES })}
        </p>
      ) : null}
      <Button variant="tertiary" onClick={() => downloadIssueReport(lines)}>
        {t("dataTransfer.import.downloadReport")}
      </Button>
    </>
  );

  const renderBody = () => {
    switch (stage.kind) {
      case "pick":
        return (
          <>
            <p>{t("dataTransfer.import.intro", { max: MAX_IMPORT_ROWS })}</p>
            <ul className="data-transfer__fields">
              {spec.fields.map((field) => (
                <li key={field.key}>
                  <code>{field.key}</code> — {field.label}
                  {field.required ? (
                    <span className="data-transfer__required">
                      {" "}
                      ({t("dataTransfer.import.required")})
                    </span>
                  ) : null}
                  {field.options ? (
                    <span className="data-transfer__muted"> · {field.options.join(" | ")}</span>
                  ) : null}
                  {field.type === "date" ? (
                    <span className="data-transfer__muted"> · YYYY-MM-DD</span>
                  ) : null}
                  {field.type === "time" ? (
                    <span className="data-transfer__muted"> · HH:MM</span>
                  ) : null}
                </li>
              ))}
            </ul>
            <div className="data-transfer__pick">
              <Button
                variant="secondary"
                onClick={() =>
                  downloadCsv(`${spec.templateName}-template.csv`, buildImportTemplate(spec.fields))
                }
              >
                {t("dataTransfer.import.downloadTemplate")}
              </Button>
              <label className="data-transfer__file-label" htmlFor={inputId}>
                {t("dataTransfer.import.chooseFile")}
              </label>
              <input
                ref={inputRef}
                id={inputId}
                type="file"
                accept=".csv,text/csv"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void handleFile(file);
                }}
              />
            </div>
          </>
        );
      case "invalidFile": {
        const { result } = stage;
        return (
          <p role="alert" className="data-transfer__error">
            {result.reason === "missingColumns"
              ? t("dataTransfer.import.missingColumns", {
                  columns: (result.missingColumns ?? []).join(", "),
                })
              : result.reason === "tooManyRows"
                ? t("dataTransfer.import.tooManyRows", { max: result.limit ?? MAX_IMPORT_ROWS })
                : t("dataTransfer.import.emptyFile")}
          </p>
        );
      }
      case "review": {
        const invalid = stage.rows.filter((row) => row.issues.length > 0);
        const validCount = stage.rows.length - invalid.length;
        return (
          <>
            <p className="data-transfer__muted">{stage.fileName}</p>
            <p role="status">
              {t("dataTransfer.import.summary", { valid: validCount, invalid: invalid.length })}
            </p>
            {stage.ignoredColumns.length > 0 ? (
              <p className="data-transfer__muted">
                {t("dataTransfer.import.ignoredColumns", {
                  columns: stage.ignoredColumns.join(", "),
                })}
              </p>
            ) : null}
            {invalid.length > 0
              ? renderIssueList(
                  invalid.map((row) => ({
                    line: row.line,
                    message: row.issues.map(issueText).join("; "),
                  })),
                )
              : null}
          </>
        );
      }
      case "running":
        return (
          <>
            <p role="status" aria-live="polite">
              {t("dataTransfer.import.progress", { done: stage.done, total: stage.total })}
            </p>
            <progress className="data-transfer__progress" value={stage.done} max={stage.total} />
          </>
        );
      case "done": {
        const failed = stage.results.filter((result) => !result.ok);
        const created = stage.results.length - failed.length;
        return (
          <>
            <p role="status">
              {t("dataTransfer.import.result", {
                created,
                failed: failed.length,
                skipped: stage.skipped + stage.notAttempted,
              })}
            </p>
            {failed.length > 0
              ? renderIssueList(
                  failed.map((result) => ({
                    line: result.line,
                    message: result.error ?? t("dataTransfer.import.unknownError"),
                  })),
                )
              : null}
          </>
        );
      }
    }
  };

  const renderFooter = () => {
    switch (stage.kind) {
      case "review": {
        const validRows = stage.rows.filter((row) => row.record !== null);
        return (
          <>
            <Button variant="tertiary" onClick={() => setStage({ kind: "pick" })}>
              {t("dataTransfer.import.chooseAnother")}
            </Button>
            <Button disabled={validRows.length === 0} onClick={() => void handleImport(stage.rows)}>
              {t("dataTransfer.import.confirm", { count: validRows.length })}
            </Button>
          </>
        );
      }
      case "invalidFile":
        return (
          <Button variant="secondary" onClick={() => setStage({ kind: "pick" })}>
            {t("dataTransfer.import.chooseAnother")}
          </Button>
        );
      case "running":
        return (
          <Button variant="secondary" onClick={() => abortRef.current?.abort()}>
            {t("dataTransfer.import.stop")}
          </Button>
        );
      default:
        return (
          <Button variant="secondary" onClick={close}>
            {t("dataTransfer.import.close")}
          </Button>
        );
    }
  };

  return (
    <>
      <Button variant="secondary" disabled={disabled} onClick={() => setOpen(true)}>
        {t("dataTransfer.import.button")}
      </Button>
      <Modal
        open={open}
        onClose={close}
        title={title}
        closeOnEsc={stage.kind !== "running"}
        closeOnOverlayClick={stage.kind !== "running"}
      >
        <Modal.Body>
          <div className="data-transfer">{renderBody()}</div>
        </Modal.Body>
        <Modal.Footer>{renderFooter()}</Modal.Footer>
      </Modal>
    </>
  );
}
