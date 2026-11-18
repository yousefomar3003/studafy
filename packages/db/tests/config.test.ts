import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { loadMigrationConfig, redact } from "../src/config";
import { MigrationConfigError } from "../src/errors";

describe("migration configuration", () => {
  test("requires database configuration", () => {
    expect(() => loadMigrationConfig({})).toThrow(MigrationConfigError);
  });

  test("loads a PostgreSQL URL without exposing it", () => {
    const url = "postgresql://user:super-secret@localhost:5432/studafy?sslmode=disable";
    const config = loadMigrationConfig({ DATABASE_URL: url });
    expect(config.url).toBe(url);
    expect(config.ssl).toBe(false);
    expect(redact(`failed for ${url} / super-secret`, config.redactions)).toBe(
      "failed for [REDACTED] / [REDACTED]",
    );
  });

  test("rejects URL and discrete configuration together", () => {
    expect(() =>
      loadMigrationConfig({ DATABASE_URL: "postgres://user@localhost/db", DATABASE_HOST: "db" }),
    ).toThrow("cannot be combined");
  });

  test("supports the existing discrete database variables", () => {
    const config = loadMigrationConfig({
      DATABASE_HOST: "postgres.internal",
      DATABASE_PORT: "5432",
      DATABASE_NAME: "studafy",
      DATABASE_USER: "studafy_admin",
      DATABASE_PASSWORD: "secret",
      DATABASE_SSL_MODE: "require",
    });
    expect(config).toMatchObject({
      host: "postgres.internal",
      port: 5432,
      database: "studafy",
      username: "studafy_admin",
      password: "secret",
      ssl: "require",
    });
  });

  test("requires CA data for verified TLS", () => {
    expect(() =>
      loadMigrationConfig({
        DATABASE_URL: "postgres://user@localhost/studafy",
        DATABASE_SSL_MODE: "verify-full",
      }),
    ).toThrow("requires DATABASE_CA_CERT");
  });
});

describe("migrations directory default (QA-004)", () => {
  test("resolves to the repository's db/migrations regardless of the working directory", () => {
    const expected = resolve(import.meta.dir, "../../../db/migrations");
    const original = process.cwd();
    try {
      for (const dir of [original, resolve(import.meta.dir, ".."), tmpdir()]) {
        process.chdir(dir);
        const config = loadMigrationConfig({ DATABASE_URL: "postgres://u:p@localhost:5432/db" });
        expect(`${dir} -> ${config.migrationsDir}`).toBe(`${dir} -> ${expected}`);
      }
    } finally {
      process.chdir(original);
    }
    expect(existsSync(expected)).toBe(true);
  });

  test("MIGRATIONS_DIR still wins", () => {
    const config = loadMigrationConfig({
      DATABASE_URL: "postgres://u:p@localhost:5432/db",
      MIGRATIONS_DIR: "/app/db/migrations",
    });
    // resolve(): an absolute POSIX path gains the current drive letter on Windows.
    expect(config.migrationsDir).toBe(resolve("/app/db/migrations"));
  });
});
