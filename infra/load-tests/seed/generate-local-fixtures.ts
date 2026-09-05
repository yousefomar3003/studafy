#!/usr/bin/env bun
// Local-only load-test fixture generator: `bun infra/load-tests/seed/generate-local-fixtures.ts`.
//
// Produces N synthetic teachers (each with one class and a roster of students) layered on top of
// the already-seeded demo tenant (`bun run db:seed`), and writes the JSON data files the k6
// scenarios in ../scenarios/ read. This exists so the k6 suite can be proven mechanically correct
// against a real API + real Postgres before anyone points it at a real environment — it is not
// how staging's load-test data gets provisioned.
//
// ## Why this never touches staging
//
// This script reuses db/seeds/guard.ts's `assertSeedAllowed` UNCHANGED, not reimplemented.
// `FORBIDDEN_HOST_PATTERNS` in that file rejects any staging-shaped hostname outright — "these are
// never a legitimate seed target" — even with its own non-local escape hatch set. A load-test
// fixture generator is not a carve-out from that rule. Provisioning a load-test tenant at staging
// scale (thousands of teachers) is therefore a separate, human-gated action outside this repo's
// automated tooling, not a script anyone can run unattended — see docs/testing/
// load-test-scenarios.md's "Credentials and fixtures" section for what that actually requires.
//
// ## Auth
//
// Each synthetic teacher/student gets a real `mock` app.oauth_identities row (the same shape
// db/seeds/data/people.ts uses for the demo personas), so the data files this script writes are
// meant to be run with `AUTH_MODE=mock-oauth` (../lib/auth.js) against a local API that has
// `MOCK_OAUTH_ISSUER_URL` configured — never `AUTH_MODE=token-pool`, since this script has no way
// to mint an access token itself (see ../lib/auth.js's header comment for why staging can never use
// the mock provider at all).
//
// ## What this does NOT do
//
// It does not publish any grades — scenario 2 (results-day-read-storm) needs a published
// grade snapshot to return anything but 404, and producing one means running the real grade-entry
// -> approval -> publish workflow (apps/api/src/modules/grades/), which is a data-authoring
// concern, not a load-test-fixture concern. The `students.json`/`ai-students.json` this script
// writes give you real, authorized identities to point that scenario's data files at once grades
// exist for them; it does not create the grades itself.

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEMO_SCHOOL_SLUG } from "../../../db/seeds/data/school";
import { assertSeedAllowed, SeedSafetyError } from "../../../db/seeds/guard";
import { createClient } from "../../../packages/db/src/client";
import { loadMigrationConfig, redact } from "../../../packages/db/src/config";

import type { ReservedSql } from "../../../packages/db/src/client";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(SCRIPT_DIR, "..", "data");
const LOAD_TEST_EMAIL_DOMAIN = "load.studafy.test";

const TEACHER_COUNT = Number(process.env.TEACHER_COUNT || 20);
const STUDENTS_PER_CLASS = Number(process.env.STUDENTS_PER_CLASS || 25);

interface DemoScaffold {
  schoolId: string;
  academicYearId: string;
  termId: string;
  courseId: string;
  roomId: string;
  countryId: string;
}

async function loadDemoScaffold(sql: ReservedSql): Promise<DemoScaffold> {
  const [school] = await sql<{ id: string }[]>`
    SELECT id FROM app.schools WHERE slug = ${DEMO_SCHOOL_SLUG}
  `;
  if (!school) {
    throw new Error(
      `Demo tenant '${DEMO_SCHOOL_SLUG}' not found — run 'bun run db:seed' first. This script only ` +
        "adds load-test scale on top of the existing demo tenant; it does not build academic " +
        "structure from scratch.",
    );
  }
  const schoolId = school.id;

  const [year] = await sql<{ id: string }[]>`
    SELECT id FROM app.academic_years WHERE school_id = ${schoolId} AND status = 'active' LIMIT 1
  `;
  const [term] = await sql<{ id: string }[]>`
    SELECT id FROM app.terms WHERE school_id = ${schoolId} AND status = 'active' LIMIT 1
  `;
  const [course] = await sql<{ id: string }[]>`
    SELECT id FROM app.courses WHERE school_id = ${schoolId} LIMIT 1
  `;
  const [room] = await sql<{ id: string }[]>`
    SELECT id FROM app.rooms WHERE school_id = ${schoolId} LIMIT 1
  `;
  const [country] = await sql<{ id: string }[]>`
    SELECT id FROM app.countries WHERE alpha2_code = 'AE'
  `;
  if (!year || !term || !course || !room || !country) {
    throw new Error(
      "Demo tenant is missing academic-year/term/course/room rows — was 'bun run db:seed' " +
        "interrupted partway through?",
    );
  }
  return {
    schoolId,
    academicYearId: year.id,
    termId: term.id,
    courseId: course.id,
    roomId: room.id,
    countryId: country.id,
  };
}

interface GeneratedClass {
  classId: string;
  period: number;
  studentIds: string[];
}

interface GeneratedTeacher {
  email: string;
  schoolId: string;
  classes: GeneratedClass[];
}

interface GeneratedStudent {
  email: string;
  schoolId: string;
  studentId: string;
  termId: string;
}

async function generate(
  sql: ReservedSql,
  scaffold: DemoScaffold,
): Promise<{ teachers: GeneratedTeacher[]; students: GeneratedStudent[] }> {
  const pad = (n: number, width: number) => String(n).padStart(width, "0");
  const nowIso = new Date().toISOString();

  const teacherUsers: Record<string, unknown>[] = [];
  const teacherRoles: Record<string, unknown>[] = [];
  const teacherOauth: Record<string, unknown>[] = [];
  const teacherProfiles: Record<string, unknown>[] = [];
  const classes: Record<string, unknown>[] = [];

  const studentUsers: Record<string, unknown>[] = [];
  const studentRoles: Record<string, unknown>[] = [];
  const studentOauth: Record<string, unknown>[] = [];
  const studentProfiles: Record<string, unknown>[] = [];
  const enrollments: Record<string, unknown>[] = [];

  const teachers: GeneratedTeacher[] = [];
  const students: GeneratedStudent[] = [];

  for (let t = 0; t < TEACHER_COUNT; t += 1) {
    const teacherUserId = randomUUID();
    const teacherId = randomUUID();
    const classId = randomUUID();
    const email = `loadtest.teacher.${pad(t, 4)}@${LOAD_TEST_EMAIL_DOMAIN}`;

    teacherUsers.push({
      id: teacherUserId,
      school_id: scaffold.schoolId,
      email,
      normalized_email: email,
      display_name: `Load Test Teacher ${pad(t, 4)}`,
      status: "active",
      email_verified_at: nowIso,
    });
    teacherRoles.push({ school_id: scaffold.schoolId, user_id: teacherUserId, role: "INSTRUCTOR" });
    teacherOauth.push({
      id: randomUUID(),
      school_id: scaffold.schoolId,
      user_id: teacherUserId,
      provider: "mock",
      subject: email,
    });
    teacherProfiles.push({
      id: teacherId,
      school_id: scaffold.schoolId,
      user_id: teacherUserId,
      employee_number: `LOAD-${pad(t, 4)}`,
      employment_status: "active",
      hire_date: "2025-08-15",
    });
    classes.push({
      id: classId,
      school_id: scaffold.schoolId,
      course_id: scaffold.courseId,
      academic_year_id: scaffold.academicYearId,
      term_id: scaffold.termId,
      lead_teacher_id: teacherId,
      room_id: scaffold.roomId,
      code: `LOAD-C-${pad(t, 4)}`,
      capacity: STUDENTS_PER_CLASS,
      status: "active",
    });

    const studentIds: string[] = [];
    for (let s = 0; s < STUDENTS_PER_CLASS; s += 1) {
      const studentUserId = randomUUID();
      const studentId = randomUUID();
      const studentEmail = `loadtest.student.${pad(t, 4)}.${pad(s, 3)}@${LOAD_TEST_EMAIL_DOMAIN}`;
      studentIds.push(studentId);

      studentUsers.push({
        id: studentUserId,
        school_id: scaffold.schoolId,
        email: studentEmail,
        normalized_email: studentEmail,
        display_name: `Load Test Student ${pad(t, 4)}.${pad(s, 3)}`,
        status: "active",
        email_verified_at: nowIso,
      });
      studentRoles.push({ school_id: scaffold.schoolId, user_id: studentUserId, role: "STUDENT" });
      studentOauth.push({
        id: randomUUID(),
        school_id: scaffold.schoolId,
        user_id: studentUserId,
        provider: "mock",
        subject: studentEmail,
      });
      studentProfiles.push({
        id: studentId,
        school_id: scaffold.schoolId,
        user_id: studentUserId,
        admission_number: `LOAD-STU-${pad(t, 4)}-${pad(s, 3)}`,
        first_name: "Load",
        last_name: `Test${pad(t, 4)}${pad(s, 3)}`,
        date_of_birth: "2012-01-01",
        nationality_country_id: scaffold.countryId,
        admission_date: "2025-09-01",
        status: "enrolled",
      });
      enrollments.push({
        school_id: scaffold.schoolId,
        class_id: classId,
        student_id: studentId,
        status: "active",
        enrolled_at: nowIso,
      });

      students.push({
        email: studentEmail,
        schoolId: scaffold.schoolId,
        studentId,
        termId: scaffold.termId,
      });
    }

    teachers.push({
      email,
      schoolId: scaffold.schoolId,
      classes: [{ classId, period: 1, studentIds }],
    });
  }

  const USER_COLS = [
    "id",
    "school_id",
    "email",
    "normalized_email",
    "display_name",
    "status",
    "email_verified_at",
  ];
  const ROLE_COLS = ["school_id", "user_id", "role"];
  const OAUTH_COLS = ["id", "school_id", "user_id", "provider", "subject"];
  const TEACHER_COLS = [
    "id",
    "school_id",
    "user_id",
    "employee_number",
    "employment_status",
    "hire_date",
  ];
  const CLASS_COLS = [
    "id",
    "school_id",
    "course_id",
    "academic_year_id",
    "term_id",
    "lead_teacher_id",
    "room_id",
    "code",
    "capacity",
    "status",
  ];
  const STUDENT_COLS = [
    "id",
    "school_id",
    "user_id",
    "admission_number",
    "first_name",
    "last_name",
    "date_of_birth",
    "nationality_country_id",
    "admission_date",
    "status",
  ];
  const ENROLLMENT_COLS = ["school_id", "class_id", "student_id", "status", "enrolled_at"];

  await sql`INSERT INTO app.users ${sql(teacherUsers, ...USER_COLS)}`;
  await sql`INSERT INTO app.user_roles ${sql(teacherRoles, ...ROLE_COLS)}`;
  await sql`INSERT INTO app.oauth_identities ${sql(teacherOauth, ...OAUTH_COLS)}`;
  await sql`INSERT INTO app.teachers ${sql(teacherProfiles, ...TEACHER_COLS)}`;
  await sql`INSERT INTO app.classes ${sql(classes, ...CLASS_COLS)}`;

  await sql`INSERT INTO app.users ${sql(studentUsers, ...USER_COLS)}`;
  await sql`INSERT INTO app.user_roles ${sql(studentRoles, ...ROLE_COLS)}`;
  await sql`INSERT INTO app.oauth_identities ${sql(studentOauth, ...OAUTH_COLS)}`;
  await sql`INSERT INTO app.students ${sql(studentProfiles, ...STUDENT_COLS)}`;
  await sql`INSERT INTO app.enrollments ${sql(enrollments, ...ENROLLMENT_COLS)}`;

  return { teachers, students };
}

async function writeDataFiles(teachers: GeneratedTeacher[], students: GeneratedStudent[]) {
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(join(OUT_DIR, "teachers.json"), JSON.stringify(teachers, null, 2));
  await writeFile(join(OUT_DIR, "students.json"), JSON.stringify(students, null, 2));
  await writeFile(
    join(OUT_DIR, "ai-students.json"),
    JSON.stringify(
      students.map((s) => ({ email: s.email, studentId: s.studentId, level: "high" })),
      null,
      2,
    ),
  );
}

async function main(): Promise<number> {
  const env = process.env;
  const config = loadMigrationConfig(env);

  try {
    assertSeedAllowed(env, config);
  } catch (error) {
    if (error instanceof SeedSafetyError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }

  const client = createClient(config, "studafy-load-test-fixtures");
  let reserved: ReservedSql | undefined;

  try {
    reserved = await client.reserve();
    const scaffold = await loadDemoScaffold(reserved);

    await reserved.unsafe("BEGIN");
    await reserved.unsafe("SET LOCAL ROLE studafy_admin");
    await reserved`SELECT set_config('app.school_id', ${scaffold.schoolId}, true)`;

    let result: { teachers: GeneratedTeacher[]; students: GeneratedStudent[] };
    try {
      result = await generate(reserved, scaffold);
      await reserved.unsafe("COMMIT");
    } catch (error) {
      await reserved.unsafe("ROLLBACK");
      throw error;
    }

    await writeDataFiles(result.teachers, result.students);

    console.log(
      `Generated ${result.teachers.length} teachers / ${result.students.length} students under ` +
        `school ${scaffold.schoolId}. Wrote teachers.json, students.json, ai-students.json to ${OUT_DIR}.`,
    );
    console.log(
      "Run scenarios against these with, e.g.:\n" +
        "  AUTH_MODE=mock-oauth TEACHERS_FILE=./data/teachers.json TEACHER_VUS=20 \\\n" +
        "    k6 run scenarios/morning-attendance-peak.js",
    );
    return 0;
  } catch (error) {
    if (error instanceof Error) error.message = redact(error.message, config.redactions);
    console.error(
      `FixtureGenerationError: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  } finally {
    reserved?.release();
    await client.end({ timeout: 5 });
  }
}

if (import.meta.main) process.exitCode = await main();
