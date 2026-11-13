/**
 * Shared shapes for the GDPR pipeline (ST-268), mirroring app.data_subject_requests
 * (db/migrations/000108) one-to-one so a row read from the database and a value about to be written
 * back to it are the same TypeScript shape everywhere in this queue.
 */

export type DsrRequestType = "export" | "erasure";
export type DsrSubjectScope = "tenant" | "user";
/**
 * `platform_export`: a whole-school export the platform console filed for an open school (000212).
 * Never an erasure, and never mistaken for the closure export (see findLatestTenantClosureRequest).
 */
export type DsrReason = "tenant_closure" | "user_request" | "platform_export";
export type DsrStatus = "queued" | "processing" | "completed" | "failed";

/** One table an erasure pass actually changed. Stored in app.data_subject_requests.redacted_tables. */
export interface RedactedTableEntry {
  table: string;
  action: "redacted" | "hard_deleted";
  columns: string[];
  rows: number;
}

/** One table an erasure pass deliberately left alone, and why. Stored in ...retained_tables. */
export interface RetainedTableEntry {
  table: string;
  reason: string;
}

export interface DataSubjectRequestRow {
  id: string;
  schoolId: string;
  requestType: DsrRequestType;
  subjectScope: DsrSubjectScope;
  reason: DsrReason;
  subjectUserId: string | null;
  /** Null only for a platform export: the operator belongs to another school (000213). */
  requestedByUserId: string | null;
  status: DsrStatus;
  storageKey: string | null;
  redactedTables: RedactedTableEntry[];
  retainedTables: RetainedTableEntry[];
  failureMessage: string | null;
  slaDueAt: Date;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}
