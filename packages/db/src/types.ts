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
