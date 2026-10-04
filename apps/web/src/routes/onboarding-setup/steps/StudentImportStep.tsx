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

import { HelpLink } from "../../../features/help/HelpLink";
import { onboardingStepHelpPath } from "../../../features/help/onboarding-guide-links";
import { api } from "../../../lib/api";
import { buildImportErrorReportCsv, downloadTextFile } from "../../../lib/csv";
import { useFormatters, useTranslation } from "../../../lib/i18n";

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
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
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
      setBanner(apiError?.detail || t("onboarding.setup.students.uploadError"));
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
      setBanner(apiError?.detail || t("onboarding.setup.students.confirmError"));
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
        <h2>{t("onboarding.setup.students.title")}</h2>
        <p>
          <HelpLink to={onboardingStepHelpPath("students")}>
            {t("onboarding.setup.needHelp")}
          </HelpLink>
        </p>

        {banner ? <p role="alert">{banner}</p> : null}

        {!record ? (
          <>
            <p>{t("onboarding.setup.students.description")}</p>
            <Button type="button" variant="secondary" onClick={handleDownloadTemplate}>
              {t("onboarding.setup.students.downloadTemplate")}
            </Button>
            <label htmlFor="student-csv-file">{t("onboarding.setup.students.fileLabel")}</label>
            <input
              id="student-csv-file"
              type="file"
              accept=".csv,text/csv"
              onChange={handleFileChange}
              disabled={uploadMutation.isPending}
            />
            {uploadMutation.isPending ? (
              <p aria-live="polite">{t("onboarding.setup.students.validating")}</p>
            ) : null}
          </>
        ) : (
          <>
            <dl>
              <dt>{t("onboarding.setup.students.rowCount")}</dt>
              <dd>{formatNumber(record.row_count)}</dd>
              <dt>{t("onboarding.setup.students.validRows")}</dt>
              <dd>{formatNumber(record.valid_rows)}</dd>
              <dt>{t("onboarding.setup.students.errorRows")}</dt>
              <dd>{formatNumber(record.error_rows)}</dd>
            </dl>

            {record.error_rows > 0 ? (
              <>
                <Table caption={t("onboarding.setup.students.errorsCaption")}>
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>{t("onboarding.setup.students.columnLine")}</TableHeaderCell>
                      <TableHeaderCell>
                        {t("onboarding.setup.students.columnField")}
                      </TableHeaderCell>
                      <TableHeaderCell>
                        {t("onboarding.setup.students.columnMessage")}
                      </TableHeaderCell>
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
                  {t("onboarding.setup.students.downloadErrors")}
                </Button>
              </>
            ) : null}

            {record.status === "confirmed" ||
            record.status === "processing" ||
            record.status === "completed" ? (
              <>
                <p>{t("onboarding.setup.students.confirmed")}</p>
                <Button type="button" onClick={handleContinue}>
                  {t("onboarding.setup.students.continue")}
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
                  {t("onboarding.setup.students.confirm", { count: record.valid_rows })}
                </Button>
                <Button type="button" variant="tertiary" onClick={() => setImportRecord(null)}>
                  {t("onboarding.setup.students.uploadAnother")}
                </Button>
              </>
            )}
          </>
        )}

        <Button type="button" variant="tertiary" onClick={onSkip}>
          {t("onboarding.setup.skipForNow")}
        </Button>
      </CardBody>
    </Card>
  );
}
