import type { AuditExportParameters } from "@studafy/audit-reporting";
import type { TransactionSql } from "postgres";

export type AuditExportStatus = "queued" | "processing" | "completed" | "failed";

export interface AuditExportJobRow {
  id: string;
  school_id: string;
  requested_by_user_id: string;
  file_format: "csv";
  status: AuditExportStatus;
  parameters: AuditExportParameters;
  storage_key: string | null;
  failure_message: string | null;
  created_at: Date;
  completed_at: Date | null;
}

const JOB_COLUMNS = `
  id, school_id, requested_by_user_id, file_format::text AS file_format,
  status::text AS status, parameters, storage_key, failure_message, created_at, completed_at
`;

function parseJob(row: Record<string, unknown>): AuditExportJobRow {
  return {
    id: row.id as string,
    school_id: row.school_id as string,
    requested_by_user_id: row.requested_by_user_id as string,
    file_format: row.file_format as "csv",
    status: row.status as AuditExportStatus,
    parameters: row.parameters as AuditExportParameters,
    storage_key: row.storage_key as string | null,
    failure_message: row.failure_message as string | null,
    created_at: row.created_at as Date,
    completed_at: row.completed_at as Date | null,
  };
}

export async function createAuditExportJob(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  parameters: AuditExportParameters,
): Promise<AuditExportJobRow> {
  const [row] = await tx<Record<string, unknown>[]>`
    INSERT INTO app.audit_export_jobs
      (school_id, requested_by_user_id, file_format, parameters)
    VALUES
      (${schoolId}, ${userId}, 'csv', ${tx.json(parameters as never)})
    RETURNING ${tx.unsafe(JOB_COLUMNS)}
  `;
  if (!row) throw new Error("audit export job insert returned no row");
  return parseJob(row);
}

export async function failAuditExportJob(
  tx: TransactionSql,
  schoolId: string,
  jobId: string,
  message: string,
): Promise<void> {
  await tx`
    UPDATE app.audit_export_jobs
    SET status = 'failed', failure_message = ${message.slice(0, 1000)},
        storage_key = NULL, completed_at = clock_timestamp(), updated_at = clock_timestamp()
    WHERE school_id = ${schoolId} AND id = ${jobId}
      AND status IN ('queued', 'processing')
  `;
}

export async function getAuditExportJob(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  jobId: string,
): Promise<AuditExportJobRow | undefined> {
  const [row] = await tx<Record<string, unknown>[]>`
    SELECT ${tx.unsafe(JOB_COLUMNS)}
    FROM app.audit_export_jobs
    WHERE school_id = ${schoolId}
      AND requested_by_user_id = ${userId}
      AND id = ${jobId}
  `;
  return row ? parseJob(row) : undefined;
}
