export type MigrationCommand = "migrate" | "status" | "validate" | "pending";
export type SslMode = "disable" | "require" | "verify-ca" | "verify-full";

export interface Migration {
  version: bigint;
  versionText: string;
  name: string;
  filename: string;
  sql: string;
  checksum: string;
  transactional: boolean;
  /** Postgres lock_timeout while this migration runs (QA-049). Default "5s". */
  lockTimeout: string;
  /** Postgres statement_timeout while this migration runs (QA-049). Default "15min". */
  statementTimeout: string;
}

export interface AppliedMigration {
  version: bigint;
  name: string;
  checksum: string;
  appliedAt: Date;
  executionDurationMs: bigint;
  toolVersion: string;
}

export interface MigrationStatus {
  initialized: boolean;
  applied: Migration[];
  pending: Migration[];
}
