/**
 * QA-066: every database pool the workers process opens carries the same TLS settings.
 *
 * The polling loops in src/index.ts used to call `postgres()` themselves and left DATABASE_CA_CERT
 * out, so only the process-wide pool verified the database against it. They now go through
 * createPool(); this keeps it that way and checks what createPool() hands postgres.js.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { createPool } from "./pool";

const CA = "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----";

describe("worker database pools (QA-066)", () => {
  test("verifies the server against DATABASE_CA_CERT when one is set", async () => {
    const sql = createPool("postgresql://u:p@db.example.com:6543/postgres?sslmode=verify-full", {
      databaseCaCert: CA,
    });
    expect(sql.options.ssl).toEqual({ ca: CA, rejectUnauthorized: true });
    await sql.end({ timeout: 0 });
  });

  test("otherwise keeps the URL's sslmode", async () => {
    const sql = createPool("postgresql://u:p@db.example.com:6543/postgres?sslmode=verify-full");
    expect(sql.options.ssl).toBe("verify-full");
    await sql.end({ timeout: 0 });
  });

  test("index.ts opens no pool of its own outside createPool()", () => {
    const source = readFileSync(join(import.meta.dir, "../index.ts"), "utf8");
    expect(source).not.toMatch(/\bpostgres\(/);
    expect(source).not.toMatch(/from "postgres"/);
  });
});
