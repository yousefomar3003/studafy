import { ApiError } from "@studafy/api-client";
import { Button, Card, DataGrid } from "@studafy/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { buildImportErrorReportCsv, downloadTextFile } from "../../../lib/csv";

import { useConfirmStudentImport, useUploadStudentImport } from "./mutations";
import {
  fetchStudentImport,
  fetchStudentImportTemplate,
  STUDENTS_LIST_KEY,
  studentImportQueryKey,
} from "./queries";

import "./students.css";

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
 * Student CSV import (ST-190): template download, dry-run upload with progress, a row-level
 * validation report, an explicit confirm step, and progress/summary while the confirmed import
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
  const queryClient = useQueryClient();

  const [record, setRecord] = useState<StudentImport | null>(null);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  const uploadImport = useUploadStudentImport();
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
    setUploadProgress(null);
    setBanner(null);
    notifiedCompletionRef.current = false;
  }

  async function handleDownloadTemplate() {
    try {
      const csv = await fetchStudentImportTemplate();
      downloadTextFile("student-import-template.csv", csv, "text/csv");
    } catch (error) {
      setBanner(apiErrorMessage(error, "Couldn't download the template. Please try again."));
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
        onSuccess: (data) => setRecord(data),
        onError: (error) => {
          setUploadProgress(null);
          setBanner(apiErrorMessage(error, "Couldn't validate that file. Please try again."));
        },
      },
    );
  }

  function handleConfirm() {
    if (!record) return;
    confirmImport.mutate(record.id, {
      onSuccess: (data) => setRecord(data),
      onError: (error) => {
        setBanner(apiErrorMessage(error, "Couldn't confirm the import. Please try again."));
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
        <Link to="/portal/admin/students">&larr; Back to students</Link>
      </p>
      <h1>Import students</h1>
      <p>Upload a CSV of students to validate. Nothing is saved until you confirm.</p>

      {banner ? (
        <p role="alert" className="students-import__banner">
          {banner}
        </p>
      ) : null}

      {step === "upload" ? (
        <Card as="section" aria-label="Upload CSV">
          <Card.Body>
            <Button type="button" variant="secondary" onClick={handleDownloadTemplate}>
              Download CSV template
            </Button>

            <div className="students-import__upload">
              <label htmlFor="student-csv-file">Student CSV file</label>
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
                  aria-label="Upload progress"
                />
                <span>Uploading… {uploadProgress?.percent ?? 0}%</span>
              </div>
            ) : null}
          </Card.Body>
        </Card>
      ) : null}

      {step === "review" && record ? (
        <ReviewPanel
          record={record}
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

interface ReviewPanelProps {
  record: StudentImport;
  confirming: boolean;
  onConfirm: () => void;
  onDownloadErrorReport: () => void;
  onReset: () => void;
}

/** The dry-run report: row counts plus one actionable line per error, all resolved in the same
 * upload response — nothing further to fetch. */
function ReviewPanel({
  record,
  confirming,
  onConfirm,
  onDownloadErrorReport,
  onReset,
}: ReviewPanelProps) {
  const errorRows = toErrorRows(record.errors);

  return (
    <Card as="section" aria-label="Validation report">
      <Card.Body>
        <dl className="students-import__stats">
          <div>
            <dt>Rows in file</dt>
            <dd>{record.row_count}</dd>
          </div>
          <div>
            <dt>Valid rows</dt>
            <dd>{record.valid_rows}</dd>
          </div>
          <div>
            <dt>Rows with errors</dt>
            <dd>{record.error_rows}</dd>
          </div>
        </dl>

        {record.error_rows > 0 ? (
          <>
            <DataGrid
              caption="Row-level validation errors"
              columns={[
                { id: "line", header: "Line", renderCell: (row: ErrorRow) => row.line, width: 80 },
                {
                  id: "field",
                  header: "Field",
                  renderCell: (row: ErrorRow) => row.field,
                  width: 200,
                },
                { id: "message", header: "Message", renderCell: (row: ErrorRow) => row.message },
              ]}
              rows={errorRows}
              getRowId={(row) => row.key}
              getRowLabel={(row) => `Line ${row.line}, ${row.field}`}
              height={Math.min(480, 44 * Math.min(errorRows.length, 10) + 44)}
            />
            <Button type="button" variant="secondary" onClick={onDownloadErrorReport}>
              Download error report
            </Button>
          </>
        ) : null}

        <div className="students-import__actions">
          <Button
            type="button"
            onClick={onConfirm}
            loading={confirming}
            disabled={record.valid_rows === 0}
          >
            Confirm import ({record.valid_rows} student
            {record.valid_rows === 1 ? "" : "s"})
          </Button>
          <Button type="button" variant="tertiary" onClick={onReset}>
            Upload a different file
          </Button>
        </div>
      </Card.Body>
    </Card>
  );
}

interface ProcessingPanelProps {
  record: StudentImport;
}

/** Shown from `confirm` through the worker picking the job up and finishing it. There is no
 * per-row progress signal from the backend (only the terminal `status` — see
 * `apps/workers/src/queues/imports/worker.ts`), so the bar is indeterminate rather than faked. */
function ProcessingPanel({ record }: ProcessingPanelProps) {
  return (
    <Card as="section" aria-label="Import progress">
      <Card.Body>
        <div className="students-import__progress" aria-live="polite">
          <progress aria-label="Import progress" />
          <span>
            {record.status === "confirmed"
              ? "Queued for processing…"
              : `Creating ${record.valid_rows} student record${record.valid_rows === 1 ? "" : "s"}…`}
          </span>
        </div>
        <p>
          This can take a few minutes for large files. You can leave this page — the import keeps
          running and the student directory will reflect it once it finishes.
        </p>
      </Card.Body>
    </Card>
  );
}

interface CompletedPanelProps {
  record: StudentImport;
  onReset: () => void;
}

function CompletedPanel({ record, onReset }: CompletedPanelProps) {
  const summary = record.summary;

  return (
    <Card as="section" aria-label="Import summary">
      <Card.Body>
        <p role="status">Import complete.</p>
        <dl className="students-import__stats">
          <div>
            <dt>Students created</dt>
            <dd>{summary?.students_created ?? 0}</dd>
          </div>
          <div>
            <dt>Rows skipped (already existed)</dt>
            <dd>{summary?.students_skipped ?? 0}</dd>
          </div>
          <div>
            <dt>Parent accounts created</dt>
            <dd>{summary?.parents_created ?? 0}</dd>
          </div>
          <div>
            <dt>Guardian links created</dt>
            <dd>{summary?.parents_linked ?? 0}</dd>
          </div>
        </dl>
        {record.error_rows > 0 ? (
          <p>
            {record.error_rows} row{record.error_rows === 1 ? "" : "s"} from the original file were
            not imported due to validation errors.
          </p>
        ) : null}
        <div className="students-import__actions">
          <Button type="button" onClick={onReset}>
            Import another file
          </Button>
          <Link to="/portal/admin/students">
            <Button type="button" variant="tertiary">
              Back to students
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
  return (
    <Card as="section" aria-label="Import failed">
      <Card.Body>
        <p role="alert">
          The import failed while processing. No students were created from this file.
        </p>
        <Button type="button" onClick={onReset}>
          Start a new import
        </Button>
      </Card.Body>
    </Card>
  );
}
