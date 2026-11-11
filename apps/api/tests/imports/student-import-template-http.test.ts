/**
 * The Excel student import template over HTTP: it is a real workbook, its header row maps onto
 * every fixed import field by itself (in English and in Arabic), and its dropdowns offer the
 * school's own grades and sections. Requires TEST_DATABASE_URL like every integration suite.
 */

import {
  readCsvSource,
  STUDENT_IMPORT_FIELDS,
  suggestColumnMapping,
} from "@studafy/student-import";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import ExcelJS from "exceljs";

import { AUTH_CHANNELS } from "../../src/modules/auth";
import {
  assignRole,
  authenticatedRequest,
  createSchool,
  createTestApp,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import type { TestApp, TestDatabase } from "../harness";

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

async function createTenant(): Promise<{ schoolId: string; userId: string }> {
  const school = await createSchool(database!.sql);
  const admin = await createUser(database!.sql, school.id);
  await assignRole(database!.sql, school.id, admin.id, "ORG_ADMIN");
  await database!.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${school.id}, true)`;
    const [year] = await tx<{ id: string }[]>`
      INSERT INTO app.academic_years (school_id, code, name, starts_on, ends_on, status)
      VALUES (${school.id}::uuid, 'Y1', 'Year 1', CURRENT_DATE - 30, CURRENT_DATE + 300, 'active')
      RETURNING id
    `;
    const [grade] = await tx<{ id: string }[]>`
      INSERT INTO app.grade_levels (school_id, name, sort_order)
      VALUES (${school.id}::uuid, 'Grade 1', 1) RETURNING id
    `;
    for (const name of ["A", "B"]) {
      await tx`
        INSERT INTO app.sections (school_id, academic_year_id, grade_level_id, name)
        VALUES (${school.id}::uuid, ${year!.id}::uuid, ${grade!.id}::uuid, ${name})
      `;
    }
  });
  return { schoolId: school.id, userId: admin.id };
}

async function downloadWorkbook(
  tenant: { schoolId: string; userId: string },
  lang: "en" | "ar",
): Promise<ExcelJS.Workbook> {
  const res = await authenticatedRequest(
    harness!,
    "GET",
    `/api/imports/students/template?format=xlsx&lang=${lang}`,
    { schoolId: tenant.schoolId, userId: tenant.userId, channel: AUTH_CHANNELS.WEB },
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("spreadsheetml");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await res.arrayBuffer());
  return workbook;
}

function headerRow(sheet: ExcelJS.Worksheet): string[] {
  const values = sheet.getRow(1).values as (string | undefined)[];
  return values.slice(1).map((value) => String(value ?? ""));
}

describeDb("student import Excel template", () => {
  for (const lang of ["en", "ar"] as const) {
    test(`the ${lang} header row maps every import field by itself`, async () => {
      const tenant = await createTenant();
      const workbook = await downloadWorkbook(tenant, lang);
      const students = workbook.worksheets[0]!;
      const headers = headerRow(students);

      const source = readCsvSource(`${headers.join(",")}\n`);
      const mapping = suggestColumnMapping(source.headers);
      for (const field of STUDENT_IMPORT_FIELDS) expect(mapping[field]).toBeDefined();
      // Only a header row: examples live on their own sheet and are never imported.
      expect(students.actualRowCount).toBe(1);
    });
  }

  test("offers the school's grades and sections as dropdowns", async () => {
    const tenant = await createTenant();
    const workbook = await downloadWorkbook(tenant, "en");
    const lists = workbook.getWorksheet("Lists")!;
    expect(lists.state).toBe("veryHidden");
    expect(lists.getCell("C1").value).toBe("Grade 1");
    expect([lists.getCell("D1").value, lists.getCell("D2").value]).toEqual(["A", "B"]);
  });

  test("the CSV template is still the default", async () => {
    const tenant = await createTenant();
    const res = await authenticatedRequest(harness!, "GET", "/api/imports/students/template", {
      schoolId: tenant.schoolId,
      userId: tenant.userId,
      channel: AUTH_CHANNELS.WEB,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toStartWith("admission_number,");
  });
});
