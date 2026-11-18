/**
 * QA-068: a search term is matched literally, never as a LIKE pattern.
 *
 * Several list endpoints bound `%${search}%` without escaping `\`, `%` and `_`. Bound, so not
 * injection, but `_` matched any character and `%` anything, which leaks matches the caller did not
 * ask for and allows slow patterns. Every such search now goes through `likeContains`.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/security/like-escaping.test.ts
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { withTenantTx } from "../../src/db/tenant-tx";
import { likeContains } from "../../src/lib/sql/like";
import { listInvitations } from "../../src/modules/auth/invitation/service";
import {
  appDatabaseFor,
  createSchool,
  createTestDatabase,
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import type { TestDatabase } from "../harness";

const describeDb = integrationEnabled ? describe : describe.skip;

describe("likeContains (QA-068)", () => {
  test("escapes the LIKE metacharacters", () => {
    expect(likeContains("a_b")).toBe("%a\\_b%");
    expect(likeContains("50%")).toBe("%50\\%%");
    expect(likeContains("back\\slash")).toBe("%back\\\\slash%");
  });

  test("no API module builds a LIKE pattern from a raw search term", () => {
    const src = join(import.meta.dir, "../../src");
    const files = (function walk(dir: string): string[] {
      return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return walk(path);
        return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
      });
    })(src);
    const offenders = files.filter((file) =>
      /`%\$\{(params|options|filters|query)\.search\}%`/.test(readFileSync(file, "utf8")),
    );
    expect(offenders.map((file) => file.slice(src.length + 1))).toEqual([]);
  });
});

let database: TestDatabase | undefined;
let schoolId: string;

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  schoolId = (await createSchool(database.sql)).id;
  await database.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    for (const email of ["first_last@school.example", "firstxlast@school.example"]) {
      await tx`
        INSERT INTO app.invitations (school_id, email, normalized_email, role, token_hash, expires_at)
        VALUES (${schoolId}::uuid, ${email}, ${email}, 'INSTRUCTOR', ${createHash("sha256").update(email).digest()},
                CURRENT_TIMESTAMP + interval '7 days')
      `;
    }
  });
}, 60_000);

afterAll(async () => {
  await database?.cleanup();
});

describeDb("invitation search (QA-068)", () => {
  test("an underscore matches only a literal underscore", async () => {
    const result = await withTenantTx(appDatabaseFor(database!.sql), { schoolId }, (tx) =>
      listInvitations(tx, schoolId, { limit: 50, search: "first_last" }),
    );
    expect(result.rows.map((row) => row.email)).toEqual(["first_last@school.example"]);
  });
});
