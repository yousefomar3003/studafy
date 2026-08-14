import { ApiError } from "@studafy/api-client";
import {
  Button,
  Card,
  CardBody,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "@studafy/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { api } from "../../../lib/api";
import { buildImportErrorReportCsv, downloadTextFile } from "../csvErrorReport";

import type { StudentImportProgress } from "../progress";
import type { components } from "@studafy/api-client";
import type { ChangeEvent } from "react";

type ImportRecord = components["schemas"]["ImportRecord"];

export interface StudentImportStepProps {
  cachedImport?: StudentImportProgress;
  onNext: (progress: StudentImportProgress) => void;
  onSkip: () => void;
}

/**
 * Step 6: uploads a student CSV for validation (`POST /api/imports/students/upload`). Nothing is
 * committed by that call — it's the dry run — so the row-level `errors` it returns are rendered
 * directly, with a client-built CSV of them to download (the API only returns errors as JSON; there
 * is no error-report file endpoint). `POST .../confirm` is a separate, explicit action.
 */
export function StudentImportStep({ cachedImport, onNext, onSkip }: StudentImportStepProps) {
  const [importRecord, setImportRecord] = useState<ImportRecord | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  const cachedImportId = cachedImport?.importId;

  const resumeQuery = useQuery({
    queryKey: ["imports", "students", cachedImportId],
    queryFn: async () => {
      const { data } = await api.GET("/api/imports/students/{importId}", {
        params: { path: { importId: cachedImportId as string } },
      });
      // openapi-fetch's generated response arrays are readonly tuples that lose their prototype
      // methods when TS widens them — same gap noted in SchoolDetailsStep.tsx. Casting to the
      // named component type restores `.map()` on `errors`.
      return (data as ImportRecord | undefined) ?? null;
    },
    enabled: Boolean(cachedImportId) && !importRecord,
  });

  const record = importRecord ?? resumeQuery.data ?? null;

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const csvText = await file.text();
      const { data } = await api.POST("/api/imports/students/upload", {
        body: csvText,
        bodySerializer: (body) => body as string,
        headers: { "Content-Type": "text/csv" },
      });
      return data as ImportRecord | undefined;
    },
    onSuccess: (data) => {
      setBanner(null);
      if (data) setImportRecord(data);
    },
    onError: (error: unknown) => {
      const apiError = error instanceof ApiError ? error : null;
      setBanner(apiError?.detail || "Could not validate that file. Please try again.");
    },
  });

  const confirmMutation = useMutation({
    mutationFn: async (importId: string) => {
      const { data } = await api.POST("/api/imports/students/{importId}/confirm", {
        params: { path: { importId } },
        body: {},
      });
      return data as ImportRecord | undefined;
    },
    onSuccess: (data) => {
      if (data) setImportRecord(data);
    },
    onError: (error: unknown) => {
      const apiError = error instanceof ApiError ? error : null;
      setBanner(apiError?.detail || "Could not confirm the import. Please try again.");
    },
  });

  async function handleDownloadTemplate() {
    const { data } = await api.GET("/api/imports/students/template");
    if (typeof data === "string") {
      downloadTextFile("student-import-template.csv", data, "text/csv");
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) uploadMutation.mutate(file);
  }

  function handleDownloadErrorReport() {
    if (!record) return;
    const csv = buildImportErrorReportCsv(record.errors);
    downloadTextFile(`import-errors-${record.id}.csv`, csv, "text/csv");
  }

  function handleContinue() {
    if (!record) return;
    onNext({ importId: record.id, status: record.status });
  }

  return (
    <Card>
      <CardBody>
        <h2>Student import</h2>

        {banner ? <p role="alert">{banner}</p> : null}

        {!record ? (
          <>
            <p>Upload a CSV of students to validate. Nothing is saved until you confirm.</p>
            <Button type="button" variant="secondary" onClick={handleDownloadTemplate}>
              Download CSV template
            </Button>
            <label htmlFor="student-csv-file">Student CSV file</label>
            <input
              id="student-csv-file"
              type="file"
              accept=".csv,text/csv"
              onChange={handleFileChange}
              disabled={uploadMutation.isPending}
            />
            {uploadMutation.isPending ? <p aria-live="polite">Validating…</p> : null}
          </>
        ) : (
          <>
            <dl>
              <dt>Rows in file</dt>
              <dd>{record.row_count}</dd>
              <dt>Valid rows</dt>
              <dd>{record.valid_rows}</dd>
              <dt>Rows with errors</dt>
              <dd>{record.error_rows}</dd>
            </dl>

            {record.error_rows > 0 ? (
              <>
                <Table caption="Row-level validation errors">
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>Line</TableHeaderCell>
                      <TableHeaderCell>Field</TableHeaderCell>
                      <TableHeaderCell>Message</TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody columnCount={3}>
                    {record.errors.map((error, index) => (
                      <TableRow key={index}>
                        <TableCell>{error.line}</TableCell>
                        <TableCell>{error.field}</TableCell>
                        <TableCell>{error.message}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <Button type="button" variant="secondary" onClick={handleDownloadErrorReport}>
                  Download error report
                </Button>
              </>
            ) : null}

            {record.status === "confirmed" ||
            record.status === "processing" ||
            record.status === "completed" ? (
              <>
                <p>Import confirmed. Students are being created in the background.</p>
                <Button type="button" onClick={handleContinue}>
                  Continue
                </Button>
              </>
            ) : (
              <>
                <Button
                  type="button"
                  onClick={() => confirmMutation.mutate(record.id)}
                  loading={confirmMutation.isPending}
                  disabled={record.valid_rows === 0}
                >
                  Confirm import ({record.valid_rows} students)
                </Button>
                <Button type="button" variant="tertiary" onClick={() => setImportRecord(null)}>
                  Upload a different file
                </Button>
              </>
            )}
          </>
        )}

        <Button type="button" variant="tertiary" onClick={onSkip}>
          Skip for now
        </Button>
      </CardBody>
    </Card>
  );
}
