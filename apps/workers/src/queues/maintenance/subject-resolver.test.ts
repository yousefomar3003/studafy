// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import {
  findSubjectPredicate,
  resolveSubjectIdentifiers,
  subjectLinkValues,
} from "./subject-resolver";

import type { Sql } from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled = Boolean(databaseUrl);
const dbTest = test.skipIf(!enabled);

let sql: Sql | undefined;
let schoolId: string;

beforeAll(async () => {
  if (!enabled) return;
  // max: 1 -- the session-level set_config() below only survives on the exact physical connection
  // it ran on; a larger pool could hand a later query a connection that never saw it.
  sql = postgres(databaseUrl!, { max: 1, ssl: false, prepare: false });
  const [country] = await sql<{ id: string }[]>`SELECT id FROM app.countries LIMIT 1`;
  const [currency] = await sql<{ id: string }[]>`SELECT id FROM app.currencies LIMIT 1`;
  const slug = "dsr-subject-test-" + crypto.randomUUID().slice(0, 8);
  const [school] = await sql<{ id: string }[]>`
    INSERT INTO app.schools (slug, name, status, country_id, default_currency_id, email, normalized_email)
    VALUES (
      ${slug}, 'DSR Subject Resolver Fixture', 'active', ${country!.id}, ${currency!.id},
      ${slug + "@example.com"}, ${slug + "@example.com"}
    )
    RETURNING id
  `;
  schoolId = school!.id;
  await sql`SELECT set_config('app.school_id', ${schoolId}, false)`;
});

afterEach(async () => {
  if (!enabled) return;
  await sql!`DELETE FROM app.notification_preferences WHERE school_id = ${schoolId}::uuid`;
  await sql!`DELETE FROM app.students WHERE school_id = ${schoolId}::uuid`;
  await sql!`DELETE FROM app.teachers WHERE school_id = ${schoolId}::uuid`;
  await sql!`DELETE FROM app.users WHERE school_id = ${schoolId}::uuid`;
});

afterAll(async () => {
  if (!enabled) return;
  await sql!`DELETE FROM app.schools WHERE id = ${schoolId}::uuid`;
  await sql?.end({ timeout: 5 });
});

async function insertUser(): Promise<string> {
  const [user] = await sql!<{ id: string }[]>`
    INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
    VALUES (${schoolId}::uuid, 'resolver@example.com', 'resolver@example.com', 'Resolver Fixture', 'active')
    RETURNING id
  `;
  return user!.id;
}

describe("resolveSubjectIdentifiers", () => {
  dbTest("a plain user with no role profile resolves neither student nor teacher id", async () => {
    const userId = await insertUser();
    const subject = await resolveSubjectIdentifiers(sql!, schoolId, userId);
    expect(subject).toEqual({ userId, studentId: null, teacherId: null });
  });

  dbTest("a student user resolves their app.students id", async () => {
    const userId = await insertUser();
    const [student] = await sql!<{ id: string }[]>`
      INSERT INTO app.students (school_id, user_id, admission_number, first_name, last_name, status)
      VALUES (${schoolId}::uuid, ${userId}::uuid, 'ADM-001', 'Test', 'Student', 'enrolled')
      RETURNING id
    `;
    const subject = await resolveSubjectIdentifiers(sql!, schoolId, userId);
    expect(subject).toEqual({ userId, studentId: student!.id, teacherId: null });
  });
});

describe("findSubjectPredicate", () => {
  dbTest("scopes app.students by user_id (the column it actually has)", async () => {
    const userId = await insertUser();
    const subject = await resolveSubjectIdentifiers(sql!, schoolId, userId);
    const predicate = await findSubjectPredicate(sql!, "students", subject);
    expect(predicate).toEqual({ column: "user_id", value: userId });
  });

  dbTest(
    "scopes app.users by its own id, which is not itself a SUBJECT_LINK_COLUMNS entry",
    async () => {
      const userId = await insertUser();
      const subject = await resolveSubjectIdentifiers(sql!, schoolId, userId);
      const predicate = await findSubjectPredicate(sql!, "users", subject);
      expect(predicate).toEqual({ column: "id", value: userId });
    },
  );

  dbTest("returns null for a table with no subject-link column at all", async () => {
    const userId = await insertUser();
    const subject = await resolveSubjectIdentifiers(sql!, schoolId, userId);
    const predicate = await findSubjectPredicate(sql!, "classes", subject);
    expect(predicate).toBeNull();
  });
});

describe("subjectLinkValues", () => {
  test("always includes user_id, and only includes resolved role ids", () => {
    expect(
      Object.fromEntries(subjectLinkValues({ userId: "u1", studentId: null, teacherId: null })),
    ).toEqual({ user_id: "u1" });
    expect(
      Object.fromEntries(subjectLinkValues({ userId: "u1", studentId: "s1", teacherId: null })),
    ).toEqual({ user_id: "u1", student_id: "s1" });
  });
});
