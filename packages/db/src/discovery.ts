import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { MigrationDiscoveryError } from "./errors";

import type { Migration } from "./types";

const MIGRATION_FILENAME = /^(\d{6})_([a-z][a-z0-9_]*)\.sql$/;
const DIRECTIVE_PREFIX = "-- studafy:migration";

export function checksum(contents: Uint8Array): string {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

/** Defaults for every migration (QA-049): fail fast on a lock, bound a runaway statement. */
export const DEFAULT_LOCK_TIMEOUT = "5s";
export const DEFAULT_STATEMENT_TIMEOUT = "15min";
/** A Postgres duration the runner may interpolate: digits and a unit, nothing else. */
const DURATION = /^\d+(ms|s|min|h)$/u;

interface MigrationPolicy {
  transactional: boolean;
  lockTimeout: string;
  statementTimeout: string;
}

/**
 * The first meaningful line may be a directive: `-- studafy:migration` followed by any of
 * `transaction=off`, `lock_timeout=<duration>`, `statement_timeout=<duration>` (QA-049 added the
 * timeouts; the original `-- studafy:migration transaction=off` still parses the same).
 */
function migrationPolicy(sql: string, filename: string): MigrationPolicy {
  const policy: MigrationPolicy = {
    transactional: true,
    lockTimeout: DEFAULT_LOCK_TIMEOUT,
    statementTimeout: DEFAULT_STATEMENT_TIMEOUT,
  };
  const firstMeaningfulLine = sql
    .split(/\r?\n/u)
    .find((line) => line.trim().length > 0)
    ?.trim();
  if (!firstMeaningfulLine?.startsWith(DIRECTIVE_PREFIX)) return policy;
  const refuse = () =>
    new MigrationDiscoveryError(
      `${filename} has an unsupported migration directive: ${firstMeaningfulLine}`,
    );
  const settings = firstMeaningfulLine.slice(DIRECTIVE_PREFIX.length).trim().split(/\s+/u);
  if (settings.length === 0 || settings[0] === "") throw refuse();
  for (const setting of settings) {
    const [key, value, ...rest] = setting.split("=");
    if (rest.length > 0 || value === undefined) throw refuse();
    if (key === "transaction" && value === "off") policy.transactional = false;
    else if (key === "lock_timeout" && DURATION.test(value)) policy.lockTimeout = value;
    else if (key === "statement_timeout" && DURATION.test(value)) policy.statementTimeout = value;
    else throw refuse();
  }
  return policy;
}

export async function discoverMigrations(directory: string): Promise<Migration[]> {
  let entries;
  try {
    // The operator-selected directory is read-only input; filenames are validated below.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown filesystem error";
    throw new MigrationDiscoveryError(`Cannot read migration directory: ${message}`);
  }

  const sqlEntries = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".sql"));
  const migrations: Migration[] = [];
  const versions = new Set<string>();
  const names = new Set<string>();

  for (const entry of sqlEntries) {
    const match = MIGRATION_FILENAME.exec(entry.name);
    if (!match) {
      throw new MigrationDiscoveryError(
        `Invalid migration filename ${entry.name}; expected 000001_canonical_name.sql`,
      );
    }
    const [, versionText, name] = match;
    if (versions.has(versionText)) {
      throw new MigrationDiscoveryError(`Duplicate migration version ${versionText}`);
    }
    if (names.has(name)) {
      throw new MigrationDiscoveryError(`Duplicate migration name ${name}`);
    }
    versions.add(versionText);
    names.add(name);

    // entry.name comes from this directory and must pass MIGRATION_FILENAME before access.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const bytes = await readFile(join(directory, entry.name));
    const sql = bytes.toString("utf8");
    if (sql.charCodeAt(0) === 0xfeff) {
      throw new MigrationDiscoveryError(`${entry.name} must not contain a UTF-8 BOM`);
    }
    if (!sql.trim()) throw new MigrationDiscoveryError(`${entry.name} must contain SQL`);
    migrations.push({
      version: BigInt(versionText),
      versionText,
      name,
      filename: entry.name,
      sql,
      checksum: checksum(bytes),
      ...migrationPolicy(sql, entry.name),
    });
  }

  migrations.sort((left, right) => (left.version < right.version ? -1 : 1));
  return migrations;
}
