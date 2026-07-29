import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  attendanceExportJobDataSchema,
  queryCompleteAttendanceReport,
} from "@studafy/attendance-reporting";
import postgres from "postgres";

import { withSystemTenantTx, withTenantTx } from "../../db/tenant-tx";

import { renderPdf, renderXlsx } from "./render";

import type { AttendanceExportJobData } from "@studafy/attendance-reporting";
import type { Job } from "bullmq";

export interface AttendanceExportWorkerConfig {
  primaryDatabaseUrl: string;
  readDatabaseUrl: string;
  s3Region?: string;
  s3Endpoint?: string;
  bucket?: string;
  databaseCaCert?: string;
}

export function attendanceReportStorageKey(data: AttendanceExportJobData): string {
  return `reports/${data.schoolId}/${data.jobId}/attendance-summary.${data.fileFormat}`;
}

export function isFinalExportAttempt(attemptsMade: number, attempts: number | undefined): boolean {
  return attemptsMade + 1 >= (attempts ?? 1);
}

export async function processAttendanceExport(
  job: Job,
  config: AttendanceExportWorkerConfig,
): Promise<
  { processed: true; storageKey: string; bytes: number } | { processed: false; reason: string }
> {
  const parsed = attendanceExportJobDataSchema.safeParse(job.data);
  if (!parsed.success) return { processed: false, reason: "invalid job data" };
  const data = parsed.data;
  if (!config.bucket || !config.s3Region) {
    throw new Error("attendance export storage is not configured");
  }

  const primary = postgres(config.primaryDatabaseUrl, {
    max: 2,
    idle_timeout: 20,
    prepare: false,
    ...(config.databaseCaCert
      ? { ssl: { ca: config.databaseCaCert, rejectUnauthorized: true } }
      : {}),
  });
  const replica = postgres(config.readDatabaseUrl, {
    max: 3,
    idle_timeout: 20,
    prepare: false,
    ...(config.databaseCaCert
      ? { ssl: { ca: config.databaseCaCert, rejectUnauthorized: true } }
      : {}),
  });
  const s3 = new S3Client({
    region: config.s3Region,
    ...(config.s3Endpoint ? { endpoint: config.s3Endpoint, forcePathStyle: true } : {}),
  });
  const key = attendanceReportStorageKey(data);

  try {
    const state = await withSystemTenantTx(primary, { schoolId: data.schoolId }, async (tx) => {
      const [row] = await tx<{ status: string }[]>`
        SELECT status::text AS status
        FROM app.report_export_jobs
        WHERE school_id = ${data.schoolId} AND id = ${data.jobId}
        FOR UPDATE
      `;
      if (!row) throw new Error("attendance export job does not exist");
      if (row.status === "completed") return "completed";
      await tx`
        UPDATE app.report_export_jobs
        SET status = 'processing', storage_key = NULL, error_message = NULL, completed_at = NULL
        WHERE school_id = ${data.schoolId} AND id = ${data.jobId}
      `;
      return "processing";
    });
    if (state === "completed") return { processed: true, storageKey: key, bytes: 0 };

    const report = await withTenantTx(
      replica,
      { schoolId: data.schoolId, userId: data.requestedByUserId },
      (tx) =>
        queryCompleteAttendanceReport(
          tx,
          data.schoolId,
          data.filter,
          data.groupBy,
          data.trendInterval,
        ),
      { readOnly: true },
    );
    const generatedAt = new Date();
    const renderInput = {
      generatedAt,
      filter: data.filter,
      groupBy: data.groupBy,
      trendInterval: data.trendInterval,
      ...report,
    };
    const artifact =
      data.fileFormat === "xlsx" ? await renderXlsx(renderInput) : await renderPdf(renderInput);
    const contentType =
      data.fileFormat === "xlsx"
        ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        : "application/pdf";

    await s3.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: artifact,
        ContentType: contentType,
        ContentDisposition: `attachment; filename="attendance-summary.${data.fileFormat}"`,
      }),
    );

    await withSystemTenantTx(primary, { schoolId: data.schoolId }, async (tx) => {
      await tx`
        UPDATE app.report_export_jobs
        SET status = 'completed',
            storage_key = ${key},
            error_message = NULL,
            completed_at = CURRENT_TIMESTAMP
        WHERE school_id = ${data.schoolId} AND id = ${data.jobId}
      `;
    });

    return { processed: true, storageKey: key, bytes: artifact.byteLength };
  } catch (error) {
    const finalAttempt = isFinalExportAttempt(job.attemptsMade, job.opts.attempts);
    if (finalAttempt) {
      await withSystemTenantTx(primary, { schoolId: data.schoolId }, async (tx) => {
        await tx`
          UPDATE app.report_export_jobs
          SET status = 'failed',
              storage_key = NULL,
              error_message = 'Attendance export generation failed',
              completed_at = CURRENT_TIMESTAMP
          WHERE school_id = ${data.schoolId} AND id = ${data.jobId}
            AND status <> 'completed'
        `;
      });
    }
    throw error;
  } finally {
    await Promise.all([primary.end({ timeout: 5 }), replica.end({ timeout: 5 })]);
  }
}
