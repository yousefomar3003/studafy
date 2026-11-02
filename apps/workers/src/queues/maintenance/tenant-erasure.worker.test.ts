/**
 * Integration test: runTenantErasure against a real, disposable school fixture. Skipped without
 * TEST_DATABASE_URL.
 */
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { resolveSubjectIdentifiers } from "./subject-resolver";
import { runTenantErasure } from "./tenant-erasure.worker";

import type { Sql } from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled = Boolean(databaseUrl);
const dbTest = test.skipIf(!enabled);

let sql: Sql | undefined;
let schoolId: string;
let userId: string;
let otherUserId: string;

beforeAll(async () => {
  if (!enabled) return;
  // max: 1 -- the session-level set_config() below only survives on the exact physical connection
  // it ran on, and runTenantErasure is exercised inside sql.begin() on this same connection.
  sql = postgres(databaseUrl!, { max: 1, ssl: false, prepare: false });
  const [country] = await sql<{ id: string }[]>`SELECT id FROM app.countries LIMIT 1`;
  const [currency] = await sql<{ id: string }[]>`SELECT id FROM app.currencies LIMIT 1`;
  const slug = "dsr-erasure-test-" + crypto.randomUUID().slice(0, 8);
  const [school] = await sql<{ id: string }[]>`
    INSERT INTO app.schools (slug, name, status, country_id, default_currency_id, email, normalized_email)
    VALUES (
      ${slug}, 'DSR Erasure Fixture', 'active', ${country!.id}, ${currency!.id},
      ${slug + "@example.com"}, ${slug + "@example.com"}
    )
    RETURNING id
  `;
  schoolId = school!.id;
  await sql`SELECT set_config('app.school_id', ${schoolId}, false)`;

  const [admin] = await sql<{ id: string }[]>`
    INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
    VALUES (${schoolId}::uuid, 'org-admin@example.com', 'org-admin@example.com', 'Org Admin', 'active')
    RETURNING id
  `;
  await sql`INSERT INTO app.user_roles (school_id, user_id, role) VALUES (${schoolId}::uuid, ${admin!.id}::uuid, 'ORG_ADMIN')`;

  const [subject] = await sql<{ id: string }[]>`
    INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
    VALUES (${schoolId}::uuid, 'subject@example.com', 'subject@example.com', 'Erase Me', 'active')
    RETURNING id
  `;
  userId = subject!.id;
  await sql`
    INSERT INTO app.students (school_id, user_id, admission_number, first_name, last_name, status)
    VALUES (${schoolId}::uuid, ${userId}::uuid, 'ADM-100', 'Erase', 'Me', 'enrolled')
  `;
  await sql`
    INSERT INTO app.refresh_tokens (school_id, user_id, token_hash, family_id, expires_at, channel)
    VALUES (${schoolId}::uuid, ${userId}::uuid, decode(repeat('ab', 32), 'hex'), gen_random_uuid(), now() + interval '1 day', 'web')
  `;

  const [other] = await sql<{ id: string }[]>`
    INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
    VALUES (${schoolId}::uuid, 'keep-me@example.com', 'keep-me@example.com', 'Keep Me', 'active')
    RETURNING id
  `;
  otherUserId = other!.id;
  await sql`
    INSERT INTO app.students (school_id, user_id, admission_number, first_name, last_name, status)
    VALUES (${schoolId}::uuid, ${otherUserId}::uuid, 'ADM-101', 'Keep', 'Me', 'enrolled')
  `;
});

afterAll(async () => {
  if (!enabled) return;
  await sql!`DELETE FROM app.refresh_tokens WHERE school_id = ${schoolId}::uuid`;
  await sql!`DELETE FROM app.students WHERE school_id = ${schoolId}::uuid`;
  await sql!`DELETE FROM app.notification_preferences WHERE school_id = ${schoolId}::uuid`;
  await sql!`DELETE FROM app.user_roles WHERE school_id = ${schoolId}::uuid`;
  await sql!`DELETE FROM app.users WHERE school_id = ${schoolId}::uuid`;
  await sql!`DELETE FROM app.schools WHERE id = ${schoolId}::uuid`;
  await sql?.end({ timeout: 5 });
});

describe("runTenantErasure", () => {
  dbTest(
    "per-user scope redacts only the subject, hard-deletes their sessions, leaves others alone",
    async () => {
      const subject = await sql!.begin((tx) => resolveSubjectIdentifiers(tx, schoolId, userId));
      expect(subject.studentId).not.toBeNull();

      const result = await sql!.begin((tx) => runTenantErasure(tx, schoolId, subject));

      const studentsEntry = result.redactedTables.find((entry) => entry.table === "students");
      expect(studentsEntry?.rows).toBe(1);
      // Every column app.students has that matches a PII pattern -- NOT NULL (first/last_name) and
      // nullable (middle_name, preferred_name, date_of_birth) alike, since a matched column is
      // redacted whether or not this particular row happened to have a value in it.
      expect(studentsEntry?.columns.sort()).toEqual([
        "date_of_birth",
        "first_name",
        "last_name",
        "middle_name",
        "preferred_name",
      ]);

      const tokensEntry = result.redactedTables.find((entry) => entry.table === "refresh_tokens");
      expect(tokensEntry).toMatchObject({ action: "hard_deleted", rows: 1 });

      const usersEntry = result.redactedTables.find((entry) => entry.table === "users");
      expect(usersEntry?.rows).toBe(1);
      const [subjectRow, adminRow] = await sql!<{ display_name: string | null; id: string }[]>`
      SELECT id, display_name FROM app.users WHERE school_id = ${schoolId}::uuid AND id IN (${userId}::uuid, ${otherUserId}::uuid)
      ORDER BY display_name NULLS FIRST
    `;
      expect(subjectRow!.display_name).toBeNull();
      expect(adminRow!.display_name).toBe("Keep Me");

      const legalHold = result.retainedTables.find((entry) => entry.table === "subscriptions");
      expect(legalHold).toBeDefined();

      const [tokenCount] = await sql!<{ n: number }[]>`
      SELECT count(*)::int AS n FROM app.refresh_tokens WHERE school_id = ${schoolId}::uuid
    `;
      expect(tokenCount!.n).toBe(0);

      const [target, untouched] = await sql!<{ first_name: string; id: string }[]>`
      SELECT id, first_name FROM app.students WHERE school_id = ${schoolId}::uuid ORDER BY admission_number
    `;
      expect(target!.first_name).toStartWith("erased-");
      expect(untouched!.first_name).toBe("Keep");

      // The school's own contact identity is a tenant-wide concern, not touched by a per-user request.
      const [school] = await sql!<
        { email: string }[]
      >`SELECT email FROM app.schools WHERE id = ${schoolId}::uuid`;
      expect(school!.email).not.toStartWith("erased-");
    },
  );

  dbTest("tenant-wide scope (closure) redacts the school's own contact identity too", async () => {
    const result = await sql!.begin((tx) => runTenantErasure(tx, schoolId));

    const schoolsEntry = result.redactedTables.find((entry) => entry.table === "schools");
    expect(schoolsEntry?.columns.sort()).toEqual(["email", "normalized_email"]);

    const [school] = await sql!<{ email: string; normalized_email: string }[]>`
      SELECT email, normalized_email FROM app.schools WHERE id = ${schoolId}::uuid
    `;
    expect(school!.email).toStartWith("erased-");
    expect(school!.normalized_email).toStartWith("erased-");

    // The "Keep Me" student, untouched by the earlier per-user test, is now redacted too.
    const [remainingStudent] = await sql!<{ first_name: string }[]>`
      SELECT first_name FROM app.students WHERE school_id = ${schoolId}::uuid AND user_id = ${otherUserId}::uuid
    `;
    expect(remainingStudent!.first_name).toStartWith("erased-");
  });
});
