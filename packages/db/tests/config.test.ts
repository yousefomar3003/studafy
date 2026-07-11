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
