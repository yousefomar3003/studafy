import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { MigrationDiscoveryError } from "./errors";

import type { Migration } from "./types";

const MIGRATION_FILENAME = /^(\d{6})_([a-z][a-z0-9_]*)\.sql$/;
const TRANSACTION_DIRECTIVE = "-- studafy:migration transaction=off";
const DIRECTIVE_PREFIX = "-- studafy:migration";

export function checksum(contents: Uint8Array): string {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

function transactionalPolicy(sql: string, filename: string): boolean {
  const firstMeaningfulLine = sql
    .split(/\r?\n/u)
    .find((line) => line.trim().length > 0)
    ?.trim();
  if (!firstMeaningfulLine?.startsWith(DIRECTIVE_PREFIX)) return true;
  if (firstMeaningfulLine !== TRANSACTION_DIRECTIVE) {
    throw new MigrationDiscoveryError(
      `${filename} has an unsupported migration directive: ${firstMeaningfulLine}`,
    );
  }
  return false;
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
      transactional: transactionalPolicy(sql, entry.name),
    });
  }

  migrations.sort((left, right) => (left.version < right.version ? -1 : 1));
  return migrations;
}
