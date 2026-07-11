import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

const repoRoot = resolve(import.meta.dir, "../../..");

const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".dart",
  ".json",
  ".yaml",
  ".yml",
  ".html",
  ".css",
  ".env",
  ".xcconfig",
  ".properties",
  ".tpl",
]);

const SKIP_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "build",
  ".turbo",
  ".dart_tool",
  ".gradle",
  "Pods",
]);

// Reads every text source file under a directory into one `path -> contents` map.
async function readSourceTree(directory: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();

  async function walk(current: string): Promise<void> {
    let entries;
    try {
      // The directory is a fixed repository path; entries are filtered before any read.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return; // A missing optional directory is not a configuration leak.
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) await walk(join(current, entry.name));
        continue;
      }
      const dot = entry.name.lastIndexOf(".");
      const extension = dot === -1 ? "" : entry.name.slice(dot);
      if (!TEXT_EXTENSIONS.has(extension)) continue;
      const path = join(current, entry.name);
      // path is composed only from directory entries beneath the fixed repository root.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      files.set(path, await readFile(path, "utf8"));
    }
  }

  await walk(directory);
  return files;
}

function findMatches(files: Map<string, string>, pattern: RegExp): string[] {
  const hits: string[] = [];
  for (const [path, contents] of files) {
    if (pattern.test(contents)) hits.push(path);
  }
  return hits;
}

describe("runtime and migration configuration separation", () => {
  test("API runtime source never references the admin role or a migration-only URL", async () => {
    const apiSource = await readSourceTree(resolve(repoRoot, "apps/api/src"));
    expect(apiSource.size).toBeGreaterThan(0);
    expect(findMatches(apiSource, /studafy_admin/)).toEqual([]);
    expect(findMatches(apiSource, /MIGRATION_DATABASE_URL/)).toEqual([]);
  });

  test("web and mobile clients contain no database URLs, credentials, or admin role", async () => {
    const clientSource = new Map([
      ...(await readSourceTree(resolve(repoRoot, "apps/web"))),
      ...(await readSourceTree(resolve(repoRoot, "apps/mobile"))),
    ]);
    expect(clientSource.size).toBeGreaterThan(0);
    expect(findMatches(clientSource, /postgres(ql)?:\/\//i)).toEqual([]);
    expect(findMatches(clientSource, /DATABASE_URL/)).toEqual([]);
    expect(findMatches(clientSource, /DATABASE_PASSWORD/)).toEqual([]);
    expect(findMatches(clientSource, /studafy_admin/)).toEqual([]);
    // A Vite-exposed variable (VITE_*) must never carry a database connection.
    expect(findMatches(clientSource, /VITE_[A-Z0-9_]*(DATABASE|POSTGRES|DB_URL)/)).toEqual([]);
  });

  test("API and migration task definitions draw credentials from different secrets", async () => {
    // Both paths are fixed repository literals joined with the repo root.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const apiTemplate = await readFile(
      resolve(repoRoot, "infra/deploy/ecs/api/task-definition.json.tpl"),
      "utf8",
    );
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const migrationsTemplate = await readFile(
      resolve(repoRoot, "infra/deploy/ecs/migrations/task-definition.json.tpl"),
      "utf8",
    );

    // Runtime credentials come from the PgBouncer application secret, not the Postgres master secret.
    expect(apiTemplate).toContain("PGBOUNCER_SECRET_ARN");
    expect(apiTemplate).not.toContain("POSTGRES_SECRET_ARN");

    // Migrations connect with the administrative master secret, never the runtime application secret.
    expect(migrationsTemplate).toContain("POSTGRES_SECRET_ARN");
    expect(migrationsTemplate).not.toContain("PGBOUNCER_SECRET_ARN");
  });
});
