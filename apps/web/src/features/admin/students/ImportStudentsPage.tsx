import { ApiError } from "@studafy/api-client";
import { Button, Card, DataGrid } from "@studafy/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { buildImportErrorReportCsv, downloadTextFile } from "../../../lib/csv";
import { useTranslation } from "../../../lib/i18n";

import { confirmBlocker, withPartialSuggestions } from "./columnMapping";
import { ColumnMappingPanel } from "./ColumnMappingPanel";
import { ImportDiffPanel } from "./ImportDiffPanel";
import {
  useConfirmStudentImport,
  useUpdateStudentImportMapping,
  useUploadStudentImport,
} from "./mutations";
import {
  fetchStudentImport,
  fetchStudentImportTemplate,
  STUDENTS_LIST_KEY,
  studentImportQueryKey,
} from "./queries";

import "./students.css";

import type { ColumnMapping } from "./columnMapping";
import type { StudentImport, UploadProgress } from "./queries";
import type { components } from "@studafy/api-client";
import type { ChangeEvent } from "react";

type ImportRowError = components["schemas"]["ImportRowError"];

const POLL_INTERVAL_MS = 1500;
const PROCESSING_STATUSES = new Set<StudentImport["status"]>(["confirmed", "processing"]);

/** Row shape the error DataGrid renders — `line`+`field` isn't guaranteed unique (a row can fail two
 * checks on the same field only once, but two different rows can share a line number after a header
 * edit), so each error is keyed by its position in the array instead. */
interface ErrorRow extends ImportRowError {
  key: string;
}

function toErrorRows(errors: readonly ImportRowError[]): ErrorRow[] {
  return errors.map((error, index) => ({ ...error, key: `${index}-${error.line}-${error.field}` }));
}

/** Which panel the flow shows, derived entirely from the import record's server-side `status` — no
 * separate step state to keep in sync with it. */
type ImportStep = "upload" | "review" | "processing" | "completed" | "failed";

function stepFor(record: StudentImport | null): ImportStep {
  if (!record) return "upload";
  if (record.status === "uploaded" || record.status === "validated") return "review";
  if (record.status === "completed") return "completed";
  if (record.status === "failed") return "failed";
  return "processing";
}

function apiErrorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? (error.detail ?? error.title) : fallback;
}

/**
 * Student CSV import (ST-190): template download, dry-run upload with progress, column mapping
 * (ST-300, see `ColumnMappingPanel`), a row-level validation report, a dry-run diff of what
 * confirming would change (`ImportDiffPanel`), an explicit confirm step, and progress/summary while the confirmed import
 * processes in the background (`POST /api/imports/students/upload` → `.../confirm`, then polling
 * `GET /api/imports/students/{importId}` — see `apps/api/src/modules/imports`).
 *
 * The whole flow is a single state machine keyed off the import record's `status`, not a locally
 * tracked step: `stepFor` maps `uploaded`/`validated` to the review panel, `confirmed`/`processing`
 * to the progress panel, and `completed`/`failed` to their own terminal panels, so the UI can never
 * drift from what the server actually did.
 *
 * On abandonment: closing the tab or navigating away before confirming leaves the uploaded row in
 * `app.student_imports` (status `uploaded`/`validated`) with no client-triggered cleanup — there is
 * no `DELETE /api/imports/students/{importId}`, so nothing this page can call. What this page does
 * own is not leaking anything client-side: the poll below is a `useQuery` that only runs while a
 * status warrants it and stops the moment the component unmounts or the status leaves that set.
 */
export default function ImportStudentsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [record, setRecord] = useState<StudentImport | null>(null);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  // The mapping the panel shows. It equals `record.column_mapping` until the admin edits it, apart
  // from the partial-name suggestions a fresh upload adds for fields the server left unmapped.
  const [mappingDraft, setMappingDraft] = useState<ColumnMapping>({});

  const uploadImport = useUploadStudentImport();
  const updateMapping = useUpdateStudentImportMapping();
  const confirmImport = useConfirmStudentImport();

  const step = stepFor(record);
  const importId = record?.id;
  const isProcessing = Boolean(record && PROCESSING_STATUSES.has(record.status));

  // Polls the import while it's confirmed/processing. `refetchInterval` reads the status from its
  // own latest fetch on every tick (not the `record` state this closure captured), so polling stops
  // itself the run after the server reports a terminal status — `enabled` only gates the first tick.
  const pollQuery = useQuery({
    queryKey: studentImportQueryKey(importId ?? "none"),
    queryFn: () => fetchStudentImport(importId as string),
    enabled: Boolean(importId) && isProcessing,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && PROCESSING_STATUSES.has(status) ? POLL_INTERVAL_MS : false;
    },
  });

  useEffect(() => {
    if (pollQuery.data) setRecord(pollQuery.data);
  }, [pollQuery.data]);

  // The worker's writes land outside this page's own queries, so the directory only learns about
  // the new students once: on the transition into `completed`.
  const notifiedCompletionRef = useRef(false);
  useEffect(() => {
    if (record?.status === "completed" && !notifiedCompletionRef.current) {
      notifiedCompletionRef.current = true;
      void queryClient.invalidateQueries({ queryKey: STUDENTS_LIST_KEY });
    }
  }, [record?.status, queryClient]);

  function reset() {
    setRecord(null);
    setMappingDraft({});
    setUploadProgress(null);
    setBanner(null);
    notifiedCompletionRef.current = false;
  }

  async function handleDownloadTemplate() {
    try {
      const csv = await fetchStudentImportTemplate();
      downloadTextFile("student-import-template.csv", csv, "text/csv");
    } catch (error) {
      setBanner(apiErrorMessage(error, t("adminPeople.students.import.page.templateError")));
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setBanner(null);
    setUploadProgress({ loaded: 0, total: file.size, percent: 0 });
    uploadImport.mutate(
      { file, onProgress: setUploadProgress },
      {
        onSuccess: (data) => {
          setRecord(data);
          setMappingDraft(withPartialSuggestions(data.column_mapping, data.source_headers));
        },
        onError: (error) => {
          setUploadProgress(null);
          setBanner(apiErrorMessage(error, t("adminPeople.students.import.page.validateError")));
        },
      },
    );
  }

  async function handleApplyMapping(mapping: ColumnMapping, saveAs?: string): Promise<boolean> {
    if (!record) return false;
    setBanner(null);
    try {
      const data = await updateMapping.mutateAsync({
        importId: record.id,
        columnMapping: mapping,
        saveAs,
      });
      setRecord(data);
      setMappingDraft(data.column_mapping);
      return true;
    } catch (error) {
      setBanner(apiErrorMessage(error, t("adminPeople.students.import.page.applyError")));
      return false;
    }
  }

  function handleConfirm() {
    if (!record) return;
    confirmImport.mutate(record.id, {
      onSuccess: (data) => setRecord(data),
      onError: (error) => {
        setBanner(apiErrorMessage(error, t("adminPeople.students.import.page.confirmError")));
      },
    });
  }

  function handleDownloadErrorReport() {
    if (!record) return;
    const csv = buildImportErrorReportCsv(record.errors);
    downloadTextFile(`import-errors-${record.id}.csv`, csv, "text/csv");
  }

  return (
    <>
      <p className="students-profile__back">
        <Link to="/portal/admin/students">{t("adminPeople.students.backToStudents")}</Link>
      </p>
      <h1>{t("adminPeople.students.import.page.title")}</h1>
      <p>{t("adminPeople.students.import.page.intro")}</p>

      {banner ? (
        <p role="alert" className="students-import__banner">
          {banner}
        </p>
      ) : null}

      {step === "upload" ? (
        <Card as="section" aria-label={t("adminPeople.students.import.page.uploadRegion")}>
          <Card.Body>
            <Button type="button" variant="secondary" onClick={handleDownloadTemplate}>
              {t("adminPeople.students.import.page.downloadTemplate")}
            </Button>

            <div className="students-import__upload">
              <label htmlFor="student-csv-file">
                {t("adminPeople.students.import.page.fileLabel")}
              </label>
              <input
                id="student-csv-file"
                type="file"
                accept=".csv,text/csv"
                onChange={handleFileChange}
                disabled={uploadImport.isPending}
              />
            </div>

            {uploadImport.isPending ? (
              <div className="students-import__progress" aria-live="polite">
                <progress
                  value={uploadProgress?.percent ?? 0}
                  max={100}
                  aria-label={t("adminPeople.students.import.page.uploadProgress")}
                />
                <span>
                  {t("adminPeople.students.import.page.uploading", {
                    percent: uploadProgress?.percent ?? 0,
                  })}
                </span>
              </div>
            ) : null}
          </Card.Body>
        </Card>
      ) : null}

      {step === "review" && record ? (
        <ReviewStep
          record={record}
          mappingDraft={mappingDraft}
          onMappingDraftChange={setMappingDraft}
          applyingMapping={updateMapping.isPending}
          onApplyMapping={handleApplyMapping}
          confirming={confirmImport.isPending}
          onConfirm={handleConfirm}
          onDownloadErrorReport={handleDownloadErrorReport}
          onReset={reset}
        />
      ) : null}

      {step === "processing" && record ? <ProcessingPanel record={record} /> : null}

      {step === "completed" && record ? <CompletedPanel record={record} onReset={reset} /> : null}

      {step === "failed" ? <FailedPanel onReset={reset} /> : null}
    </>
  );
}

interface ReviewStepProps {
  record: StudentImport;
  mappingDraft: ColumnMapping;
  onMappingDraftChange: (draft: ColumnMapping) => void;
  applyingMapping: boolean;
  onApplyMapping: (mapping: ColumnMapping, saveAs?: string) => Promise<boolean>;
  confirming: boolean;
  onConfirm: () => void;
  onDownloadErrorReport: () => void;
  onReset: () => void;
}

/** Everything between upload and confirm: mapping, validation report, preview, then confirm. The
 * preview is only fetched once confirm is possible; before that it would describe a mapping the
 * admin is still changing, or one that stages no records at all. */
function ReviewStep({
  record,
  mappingDraft,
  onMappingDraftChange,
  applyingMapping,
  onApplyMapping,
  confirming,
  onConfirm,
  onDownloadErrorReport,
  onReset,
}: ReviewStepProps) {
  const { t } = useTranslation();
  const blocker = confirmBlocker(mappingDraft, record.column_mapping, record.valid_rows, t);

  return (
    <div className="students-import__review">
      <ColumnMappingPanel
        record={record}
        draft={mappingDraft}
        onDraftChange={onMappingDraftChange}
        applying={applyingMapping}
        onApply={onApplyMapping}
      />
      <ReviewPanel record={record} onDownloadErrorReport={onDownloadErrorReport} />
      {blocker === null ? <ImportDiffPanel record={record} /> : null}
      <ConfirmBar
        validRows={record.valid_rows}
        blocker={blocker}
        confirming={confirming}
        onConfirm={onConfirm}
        onReset={onReset}
      />
    </div>
  );
}

interface ReviewPanelProps {
  record: StudentImport;
  onDownloadErrorReport: () => void;
}

/** The dry-run report: row counts plus one actionable line per error, all resolved in the same
 * upload response — nothing further to fetch. */
function ReviewPanel({ record, onDownloadErrorReport }: ReviewPanelProps) {
  const { t } = useTranslation();
  const errorRows = toErrorRows(record.errors);

  return (
    <Card as="section" aria-label={t("adminPeople.students.import.report.region")}>
      <Card.Body>
        <dl className="students-import__stats">
          <div>
            <dt>{t("adminPeople.students.import.report.rowsInFile")}</dt>
            <dd>{record.row_count}</dd>
          </div>
          <div>
            <dt>{t("adminPeople.students.import.report.validRows")}</dt>
            <dd>{record.valid_rows}</dd>
          </div>
          <div>
            <dt>{t("adminPeople.students.import.report.rowsWithErrors")}</dt>
            <dd>{record.error_rows}</dd>
          </div>
        </dl>

        {record.error_rows > 0 ? (
          <>
            <DataGrid
              caption={t("adminPeople.students.import.report.caption")}
              columns={[
                {
                  id: "line",
                  header: t("adminPeople.students.import.report.columns.line"),
                  renderCell: (row: ErrorRow) => row.line,
                  width: 80,
                },
                {
                  id: "field",
                  header: t("adminPeople.students.import.report.columns.field"),
                  renderCell: (row: ErrorRow) => row.field,
                  width: 200,
                },
                {
                  id: "message",
                  header: t("adminPeople.students.import.report.columns.message"),
                  renderCell: (row: ErrorRow) => row.message,
                },
              ]}
              rows={errorRows}
              getRowId={(row) => row.key}
              getRowLabel={(row) =>
                t("adminPeople.students.import.report.rowLabel", {
                  line: row.line,
                  field: row.field,
                })
              }
              height={Math.min(480, 44 * Math.min(errorRows.length, 10) + 44)}
            />
            <Button type="button" variant="secondary" onClick={onDownloadErrorReport}>
              {t("adminPeople.students.import.report.downloadErrorReport")}
            </Button>
          </>
        ) : null}
      </Card.Body>
    </Card>
  );
}

const CONFIRM_BLOCKER_ID = "students-import-confirm-blocker";

interface ConfirmBarProps {
  validRows: number;
  blocker: string | null;
  confirming: boolean;
  onConfirm: () => void;
  onReset: () => void;
}

function ConfirmBar({ validRows, blocker, confirming, onConfirm, onReset }: ConfirmBarProps) {
  const { t } = useTranslation();
  return (
    <div className="students-import__confirm">
      {blocker ? (
        <p id={CONFIRM_BLOCKER_ID} className="students-import__warning" role="status">
          {blocker}
        </p>
      ) : null}
      <div className="students-import__actions">
        <Button
          type="button"
          onClick={onConfirm}
          loading={confirming}
          disabled={blocker !== null}
          aria-describedby={blocker ? CONFIRM_BLOCKER_ID : undefined}
        >
          {t("adminPeople.students.import.confirm.button", { count: validRows })}
        </Button>
        <Button type="button" variant="tertiary" onClick={onReset}>
          {t("adminPeople.students.import.confirm.uploadDifferent")}
        </Button>
      </div>
    </div>
  );
}

interface ProcessingPanelProps {
  record: StudentImport;
}

/** Shown from `confirm` through the worker picking the job up and finishing it. There is no
 * per-row progress signal from the backend (only the terminal `status` — see
 * `apps/workers/src/queues/imports/worker.ts`), so the bar is indeterminate rather than faked. */
function ProcessingPanel({ record }: ProcessingPanelProps) {
  const { t } = useTranslation();
  return (
    <Card as="section" aria-label={t("adminPeople.students.import.processing.region")}>
      <Card.Body>
        <div className="students-import__progress" aria-live="polite">
          <progress aria-label={t("adminPeople.students.import.processing.region")} />
          <span>
            {record.status === "confirmed"
              ? t("adminPeople.students.import.processing.queued")
              : t("adminPeople.students.import.processing.creating", { count: record.valid_rows })}
          </span>
        </div>
        <p>{t("adminPeople.students.import.processing.body")}</p>
      </Card.Body>
    </Card>
  );
}

interface CompletedPanelProps {
  record: StudentImport;
  onReset: () => void;
}

function CompletedPanel({ record, onReset }: CompletedPanelProps) {
  const { t } = useTranslation();
  const summary = record.summary;

  return (
    <Card as="section" aria-label={t("adminPeople.students.import.completed.region")}>
      <Card.Body>
        <p role="status">{t("adminPeople.students.import.completed.complete")}</p>
        <dl className="students-import__stats">
          <div>
            <dt>{t("adminPeople.students.import.completed.studentsCreated")}</dt>
            <dd>{summary?.students_created ?? 0}</dd>
          </div>
          <div>
            <dt>{t("adminPeople.students.import.completed.rowsSkipped")}</dt>
            <dd>{summary?.students_skipped ?? 0}</dd>
          </div>
          <div>
            <dt>{t("adminPeople.students.import.completed.parentsCreated")}</dt>
            <dd>{summary?.parents_created ?? 0}</dd>
          </div>
          <div>
            <dt>{t("adminPeople.students.import.completed.guardianLinks")}</dt>
            <dd>{summary?.parents_linked ?? 0}</dd>
          </div>
        </dl>
        {record.error_rows > 0 ? (
          <p>
            {t("adminPeople.students.import.completed.notImported", { count: record.error_rows })}
          </p>
        ) : null}
        <div className="students-import__actions">
          <Button type="button" onClick={onReset}>
            {t("adminPeople.students.import.completed.importAnother")}
          </Button>
          <Link to="/portal/admin/students">
            <Button type="button" variant="tertiary">
              {t("adminPeople.students.import.completed.backToStudents")}
            </Button>
          </Link>
        </div>
      </Card.Body>
    </Card>
  );
}

interface FailedPanelProps {
  onReset: () => void;
}

function FailedPanel({ onReset }: FailedPanelProps) {
  const { t } = useTranslation();
  return (
    <Card as="section" aria-label={t("adminPeople.students.import.failed.region")}>
      <Card.Body>
        <p role="alert">{t("adminPeople.students.import.failed.body")}</p>
        <Button type="button" onClick={onReset}>
          {t("adminPeople.students.import.failed.startNew")}
        </Button>
      </Card.Body>
    </Card>
  );
}
