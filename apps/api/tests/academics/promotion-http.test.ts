/**
 * Moving students to the next year over HTTP (`GET /api/academics/promotions/preview`,
 * `POST /api/academics/promotions/apply`): each finalized annual result proposes a destination,
 * applying places or graduates students, re-running changes nothing, the source year is untouched,
 * and only school leadership on the web may do it.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { AUTH_CHANNELS } from "../../src/modules/auth";
import {
  assignRole,
  authenticatedRequest,
  createSchool,
  createStudent,
  createTestApp,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import type { TestApp, TestDatabase } from "../harness";
import type { Role } from "@studafy/constants";

const describeDb = integrationEnabled ? describe : describe.skip;

let database: TestDatabase | undefined;
let harness: TestApp | undefined;

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  const created = createTestApp({ database: database.sql });
  await created.ready;
  harness = created;
}, 120_000);

afterAll(async () => {
  harness?.keyStore.destroy();
  await database?.cleanup();
});

type Name =
  "promoted" | "retained" | "resit" | "graduating" | "noResult" | "withdrawn" | "noSection";

interface Seeded {
  schoolId: string;
  principalId: string;
  sourceYearId: string;
  targetYearId: string;
  students: Record<Name, string>;
  sections: { source8A: string; target8A: string; target9A: string };
}

async function seed(): Promise<Seeded> {
  const sql = database!.sql;
  const school = await createSchool(sql);
  const principal = await createUser(sql, school.id);
  await assignRole(sql, school.id, principal.id, "PRINCIPAL");

  const names: Name[] = [
    "promoted",
    "retained",
    "resit",
    "graduating",
    "noResult",
    "withdrawn",
    "noSection",
  ];
  const students = {} as Record<Name, string>;
  for (const [index, name] of names.entries()) {
    const student = await createStudent(sql, school.id, {
      firstName: name,
      lastName: "Student",
      admissionNumber: `ADM-${index}`,
    });
    students[name] = student.id;
  }

  return sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${school.id}, true)`;
    await tx`UPDATE app.students SET status = 'enrolled' WHERE school_id = ${school.id}::uuid`;
    await tx`UPDATE app.students SET status = 'withdrawn' WHERE id = ${students.withdrawn}::uuid`;

    const [source] = await tx<{ id: string }[]>`
      INSERT INTO app.academic_years (school_id, code, name, starts_on, ends_on, status)
      VALUES (${school.id}::uuid, 'Y1', '2025-2026', CURRENT_DATE - 300, CURRENT_DATE + 30, 'active')
      RETURNING id
    `;
    const [target] = await tx<{ id: string }[]>`
      INSERT INTO app.academic_years (school_id, code, name, starts_on, ends_on, status)
      VALUES (${school.id}::uuid, 'Y2', '2026-2027', CURRENT_DATE + 60, CURRENT_DATE + 360, 'planned')
      RETURNING id
    `;
    const grade = async (name: string, order: number) => {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO app.grade_levels (school_id, name, sort_order)
        VALUES (${school.id}::uuid, ${name}, ${order}) RETURNING id
      `;
      return row!.id;
    };
    const g8 = await grade("Grade 8", 8);
    const g9 = await grade("Grade 9", 9);
    const section = async (yearId: string, gradeId: string, name: string) => {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO app.sections (school_id, academic_year_id, grade_level_id, name)
        VALUES (${school.id}::uuid, ${yearId}::uuid, ${gradeId}::uuid, ${name}) RETURNING id
      `;
      return row!.id;
    };
    const source8A = await section(source!.id, g8, "A");
    const source8B = await section(source!.id, g8, "B");
    const source9A = await section(source!.id, g9, "A");
    const target8A = await section(target!.id, g8, "A");
    const target9A = await section(target!.id, g9, "A");

    const place = async (studentId: string, sectionId: string) => {
      await tx`
        INSERT INTO app.student_sections (school_id, student_id, academic_year_id, section_id)
        VALUES (${school.id}::uuid, ${studentId}::uuid, ${source!.id}::uuid, ${sectionId}::uuid)
      `;
    };
    for (const name of ["promoted", "retained", "resit", "noResult", "withdrawn"] as const) {
      await place(students[name], source8A);
    }
    await place(students.noSection, source8B);
    await place(students.graduating, source9A);

    const finalize = async (sectionId: string, results: [string, string][]) => {
      const [fin] = await tx<{ id: string }[]>`
        INSERT INTO app.result_finalizations
          (school_id, academic_year_id, section_id, term_id, finalized_by_user_id)
        VALUES (${school.id}::uuid, ${source!.id}::uuid, ${sectionId}::uuid, NULL,
                ${principal.id}::uuid)
        RETURNING id
      `;
      for (const [studentId, status] of results) {
        await tx`
          INSERT INTO app.student_overall_results
            (school_id, finalization_id, student_id, status, average_percentage, academic_status,
             subjects_failed)
          VALUES (${school.id}::uuid, ${fin!.id}::uuid, ${studentId}::uuid, 'complete', 75,
                  ${status}, ${status === "promoted" ? 0 : 2})
        `;
      }
    };
    await finalize(source8A, [
      [students.promoted, "promoted"],
      [students.retained, "retained"],
      [students.resit, "supplementary"],
      [students.withdrawn, "promoted"],
    ]);
    await finalize(source8B, [[students.noSection, "promoted"]]);
    await finalize(source9A, [[students.graduating, "promoted"]]);

    return {
      schoolId: school.id,
      principalId: principal.id,
      sourceYearId: source!.id,
      targetYearId: target!.id,
      students,
      sections: { source8A, target8A, target9A },
    };
  });
}

function request(
  seeded: Seeded,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  options: { roles?: Role[]; channel?: string } = {},
) {
  return authenticatedRequest(
    harness!,
    method,
    path,
    {
      schoolId: seeded.schoolId,
      userId: seeded.principalId,
      channel: (options.channel ?? AUTH_CHANNELS.WEB) as typeof AUTH_CHANNELS.WEB,
      roles: options.roles ?? ["PRINCIPAL"],
    },
    body === undefined
      ? undefined
      : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } },
  );
}

function previewPath(seeded: Seeded): string {
  return `/api/academics/promotions/preview?source_year_id=${seeded.sourceYearId}&target_year_id=${seeded.targetYearId}`;
}

interface PreviewStudent {
  student_id: string;
  admission_number: string | null;
  proposed_action: string;
  proposed_section_id: string | null;
  reason: string;
  needs_decision: boolean;
  done: string | null;
}

async function preview(seeded: Seeded): Promise<Map<string, PreviewStudent>> {
  const response = await request(seeded, "GET", previewPath(seeded));
  expect(response.status).toBe(200);
  const body = (await response.json()) as { students: PreviewStudent[] };
  return new Map(body.students.map((student) => [student.student_id, student]));
}

describeDb("moving students to the next year", () => {
  test("the preview proposes a destination from each student's annual result", async () => {
    const seeded = await seed();
    const rows = await preview(seeded);
    const { students, sections } = seeded;

    expect(rows.get(students.promoted)).toMatchObject({
      proposed_action: "place",
      proposed_section_id: sections.target9A,
      reason: "promoted",
      needs_decision: false,
      // A principal has no billing access, so admission numbers stay hidden.
      admission_number: null,
    });
    expect(rows.get(students.retained)).toMatchObject({
      proposed_section_id: sections.target8A,
      reason: "retained",
    });
    expect(rows.get(students.resit)).toMatchObject({
      proposed_action: "skip",
      reason: "awaiting_resit",
    });
    expect(rows.get(students.graduating)).toMatchObject({
      proposed_action: "graduate",
      reason: "final_grade",
    });
    expect(rows.get(students.noResult)).toMatchObject({
      reason: "no_result",
      needs_decision: true,
    });
    expect(rows.get(students.withdrawn)).toMatchObject({ reason: "inactive_student" });
    // 8B has no 9B to move into.
    expect(rows.get(students.noSection)).toMatchObject({
      reason: "no_matching_section",
      needs_decision: true,
    });
  });

  test("applying places and graduates, re-running changes nothing, the source year is untouched", async () => {
    const seeded = await seed();
    const { students, sections } = seeded;
    const decisions = [
      { student_id: students.promoted, action: "place", target_section_id: sections.target9A },
      { student_id: students.retained, action: "place", target_section_id: sections.target8A },
      { student_id: students.graduating, action: "graduate" },
      { student_id: students.resit, action: "skip" },
      // The principal's own choice for a student with no result.
      { student_id: students.noResult, action: "place", target_section_id: sections.target9A },
      // A withdrawn student cannot be placed.
      { student_id: students.withdrawn, action: "place", target_section_id: sections.target9A },
    ];
    const body = {
      source_year_id: seeded.sourceYearId,
      target_year_id: seeded.targetYearId,
      decisions,
    };

    const first = await request(seeded, "POST", "/api/academics/promotions/apply", body);
    expect(first.status).toBe(200);
    const outcomes = new Map(
      (
        (await first.json()) as {
          outcomes: { student_id: string; outcome: string; error: string | null }[];
        }
      ).outcomes.map((outcome) => [outcome.student_id, outcome]),
    );
    expect(outcomes.get(students.promoted)?.outcome).toBe("moved_up");
    expect(outcomes.get(students.retained)?.outcome).toBe("retained");
    expect(outcomes.get(students.graduating)?.outcome).toBe("graduated");
    expect(outcomes.get(students.resit)?.outcome).toBe("skipped");
    expect(outcomes.get(students.noResult)?.outcome).toBe("moved_up");
    expect(outcomes.get(students.withdrawn)).toMatchObject({
      outcome: "failed",
      error: "student_inactive",
    });

    const second = await request(seeded, "POST", "/api/academics/promotions/apply", body);
    const again = new Map(
      (
        (await second.json()) as { outcomes: { student_id: string; outcome: string }[] }
      ).outcomes.map((outcome) => [outcome.student_id, outcome.outcome]),
    );
    expect(again.get(students.promoted)).toBe("already_placed");
    expect(again.get(students.retained)).toBe("already_placed");
    expect(again.get(students.graduating)).toBe("already_graduated");

    const rows = await preview(seeded);
    expect(rows.get(students.promoted)).toMatchObject({ done: "placed", reason: "already_placed" });
    expect(rows.get(students.graduating)).toMatchObject({ done: "graduated" });

    const sql = database!.sql;
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE studafy_admin");
      await tx`SELECT set_config('app.school_id', ${seeded.schoolId}, true)`;
      // One placement per student in the target year — re-running did not duplicate.
      const [target] = await tx<{ count: number }[]>`
        SELECT count(*)::int AS count FROM app.student_sections
        WHERE academic_year_id = ${seeded.targetYearId}::uuid
      `;
      expect(target!.count).toBe(3);
      // The source year keeps all seven placements and every result.
      const [source] = await tx<{ count: number }[]>`
        SELECT count(*)::int AS count FROM app.student_sections
        WHERE academic_year_id = ${seeded.sourceYearId}::uuid
      `;
      expect(source!.count).toBe(7);
      const [results] = await tx<{ count: number }[]>`
        SELECT count(*)::int AS count FROM app.student_overall_results
        WHERE school_id = ${seeded.schoolId}::uuid
      `;
      expect(results!.count).toBe(6);
      const audit = await tx<{ target_table: string }[]>`
        SELECT target_table FROM app.audit_logs
        WHERE school_id = ${seeded.schoolId}::uuid
          AND new_values->>'reason' = 'year_promotion'
      `;
      expect(audit.filter((row) => row.target_table === "student_sections")).toHaveLength(3);
      expect(audit.filter((row) => row.target_table === "students")).toHaveLength(1);
    });
  });

  test("only school leadership on the web may preview or apply", async () => {
    const seeded = await seed();
    const body = {
      source_year_id: seeded.sourceYearId,
      target_year_id: seeded.targetYearId,
      decisions: [{ student_id: seeded.students.resit, action: "skip" }],
    };
    for (const roles of [["INSTRUCTOR"], ["FINANCE"], ["PARENT"]] as Role[][]) {
      expect((await request(seeded, "GET", previewPath(seeded), undefined, { roles })).status).toBe(
        403,
      );
      expect(
        (await request(seeded, "POST", "/api/academics/promotions/apply", body, { roles })).status,
      ).toBe(403);
    }
    const mobile = await request(seeded, "GET", previewPath(seeded), undefined, {
      channel: AUTH_CHANNELS.MOBILE,
    });
    expect(mobile.status).toBe(403);
    expect(
      (await request(seeded, "GET", previewPath(seeded), undefined, { roles: ["ORG_ADMIN"] }))
        .status,
    ).toBe(200);
  });

  test("the same year twice is refused", async () => {
    const seeded = await seed();
    const response = await request(
      seeded,
      "GET",
      `/api/academics/promotions/preview?source_year_id=${seeded.sourceYearId}&target_year_id=${seeded.sourceYearId}`,
    );
    expect(response.status).toBe(400);
  });
});
