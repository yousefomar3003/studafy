/**
 * Ministry results export (000264) against a real migrated database with RLS armed.
 *
 * Grade 10, this year. Section 10A is finalized for term 1 and for the year; 10B is not finalized.
 *
 *   10A  Amal Haddad (national ID 9981234567, a sensitive record field): Math 86.456 B+ passed,
 *        Art 40 F failed; overall 63.2 promoted.
 *        Badr Nasser (no national ID): Math 70 C passed, Art 55 D passed; overall 62.5 promoted.
 *
 * The template exports per subject, has a ministry code for Math only and maps pass/fail.
 *
 *   TEST_DATABASE_URL=postgres://... bun test src/modules/ministry-export/__tests__/ministry-export.integration.test.ts
 */

import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import {
  assignRole,
  authenticatedRequest,
  createFullTenant,
  createStudent,
  createSubject,
  createTestApp,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
} from "../../../../tests/harness";
import { withTenantTx } from "../../../db/tenant-tx";
import { createGradeLevel, createSection } from "../../academics/section-service";

import type {
  TestApp,
  TestAuthContext,
  TestDatabase,
  TenantFixture,
} from "../../../../tests/harness";
import type { MinistryExportPreviewView, MinistryExportTemplateView } from "../service";

const describeDb = integrationEnabled ? describe : describe.skip;

let db: TestDatabase;
let client: ReturnType<typeof postgres> | undefined;
let http: TestApp;
let tenant: TenantFixture;
let otherTenant: TenantFixture;

const ids = {} as Record<string, string>;
let bySubject: MinistryExportTemplateView;

const NATIONAL_ID = "9981234567";

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createTestDatabase();
  await migrateDatabase(db.url);
  tenant = await createFullTenant(db.sql);
  otherTenant = await createFullTenant(db.sql);
  client = postgres(db.url, { max: 1, prepare: false });
  const created = createTestApp({ database: db.sql });
  await created.ready;
  http = created;
}, 120_000);

afterAll(async () => {
  http?.keyStore.destroy();
  if (client) await client.end({ timeout: 1 });
  if (db?.cleanup) await db.cleanup();
});

const auth = (userId: string, role: keyof typeof ROLES, fixture = tenant): TestAuthContext => ({
  schoolId: fixture.schoolId,
  userId,
  roles: [ROLES[role]],
  channel: "web",
});
const adminAuth = () => auth(tenant.users.ORG_ADMIN.id, "ORG_ADMIN");
const principalAuth = () => auth(ids.principal!, "PRINCIPAL");
const otherAdminAuth = () => auth(otherTenant.users.ORG_ADMIN.id, "ORG_ADMIN", otherTenant);
const teacherAuth = () => auth(tenant.teachers[0]!.userId, "INSTRUCTOR");

async function request(method: string, path: string, as: TestAuthContext, body?: unknown) {
  return authenticatedRequest(
    http,
    method,
    path,
    as,
    body === undefined
      ? undefined
      : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } },
  );
}

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  as: TestAuthContext,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await request(method, path, as, body);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

const TEMPLATES = "/api/grading/ministry-export-templates";
const PREVIEW = "/api/grading/ministry-exports/preview";
const DOWNLOAD = "/api/grading/ministry-exports/download";

interface SubjectRow {
  student: string;
  subject: string;
  percentage: number;
  label: string;
  passed: boolean;
}

/** One finalization of 10A for the term (or the year), as finalization would store it. */
async function seedFinalization(termId: string | null, rows: SubjectRow[]) {
  const [finalization] = await db.sql<{ id: string }[]>`
    INSERT INTO app.result_finalizations (
      school_id, academic_year_id, section_id, term_id, version, finalized_by_user_id
    )
    VALUES (
      ${tenant.schoolId}::uuid, ${tenant.academicYear.id}::uuid, ${ids.section10a!}::uuid,
      ${termId}::uuid, 1, ${tenant.users.ORG_ADMIN.id}::uuid
    )
    RETURNING id
  `;
  for (const [student, average] of [
    ["amal", 63.2],
    ["badr", 62.5],
  ] as const) {
    await db.sql`
      INSERT INTO app.student_overall_results (
        school_id, finalization_id, student_id, status, average_percentage, total_obtained,
        total_max, grade_label, subjects_failed, academic_status
      )
      VALUES (
        ${tenant.schoolId}::uuid, ${finalization!.id}::uuid, ${ids[student]!}::uuid, 'complete',
        ${average}, ${average * 2}, 200, 'C', 0, 'promoted'
      )
    `;
  }
  for (const row of rows) {
    await db.sql`
      INSERT INTO app.student_subject_results (
        school_id, finalization_id, student_id, subject_id, status, percentage, marks_obtained,
        max_marks, grade_label, gpa_points, passed, include_in_average, include_on_certificate,
        config_snapshot, breakdown
      )
      VALUES (
        ${tenant.schoolId}::uuid, ${finalization!.id}::uuid, ${ids[row.student]!}::uuid,
        ${ids[row.subject]!}::uuid, 'complete', ${row.percentage}, ${row.percentage}, 100,
        ${row.label}, NULL, ${row.passed}, true, true,
        ${db.sql.json({ version: 1 } as never)}::jsonb, ${db.sql.json({} as never)}::jsonb
      )
    `;
  }
  return finalization!.id;
}

function templateBody(overrides: Record<string, unknown> = {}) {
  return {
    name: "Jordan MoE",
    target: "Jordan MoE",
    file_format: "csv",
    encoding: "utf8_bom",
    row_kind: "subject",
    decimal_places: 1,
    national_id_field_id: ids.nationalIdField,
    columns: [
      { header: "School", field: "constant", constant_value: "4412" },
      { header: "National ID", field: "national_id" },
      { header: "Name", field: "full_name" },
      { header: "Section", field: "section" },
      { header: "Subject code", field: "subject_ministry_code" },
      { header: "Mark", field: "mark" },
      { header: "Grade", field: "grade_label" },
      {
        header: "Result",
        field: "status",
        value_map: [
          { from: "pass", to: "1" },
          { from: "fail", to: "2" },
        ],
      },
    ],
    subject_codes: [{ subject_id: ids.math, code: "M-101" }],
    ...overrides,
  };
}

const run = (overrides: Record<string, unknown> = {}) => ({
  template_id: bySubject.id,
  academic_year_id: tenant.academicYear.id,
  term_id: tenant.term.id,
  grade_level_ids: [ids.grade10],
  ...overrides,
});

describeDb("ministry results export", () => {
  test("setup: grade 10, two sections, results and a sensitive national ID field", async () => {
    ids.amal = tenant.students[0]!.id;
    await db.sql`
      UPDATE app.students SET first_name = 'Amal', last_name = 'Haddad', middle_name = NULL
      WHERE id = ${ids.amal}::uuid
    `;
    ids.badr = (
      await createStudent(db.sql, tenant.schoolId, { firstName: "Badr", lastName: "Nasser" })
    ).id;
    ids.math = (await createSubject(db.sql, tenant.schoolId, { code: "MATH", name: "Math" })).id;
    ids.art = (await createSubject(db.sql, tenant.schoolId, { code: "ART", name: "Art" })).id;
    ids.otherSubject = (await createSubject(db.sql, otherTenant.schoolId, { code: "X" })).id;
    const principal = await createUser(db.sql, tenant.schoolId, { displayName: "Principal" });
    await assignRole(db.sql, tenant.schoolId, principal.id, ROLES.PRINCIPAL);
    ids.principal = principal.id;

    await withTenantTx(
      client!,
      { schoolId: tenant.schoolId, userId: tenant.users.ORG_ADMIN.id },
      async (tx) => {
        ids.grade10 = (
          await createGradeLevel(tx, tenant.schoolId, { name: "Grade 10", sort_order: 10 })
        ).id;
        for (const name of ["10A", "10B"]) {
          ids[`section${name.toLowerCase()}`] = (
            await createSection(tx, tenant.schoolId, {
              academic_year_id: tenant.academicYear.id,
              grade_level_id: ids.grade10,
              name,
            })
          ).id;
        }
      },
    );
    const rows: SubjectRow[] = [
      { student: "amal", subject: "math", percentage: 86.456, label: "B+", passed: true },
      { student: "amal", subject: "art", percentage: 40, label: "F", passed: false },
      { student: "badr", subject: "math", percentage: 70, label: "C", passed: true },
      { student: "badr", subject: "art", percentage: 55, label: "D", passed: true },
    ];
    await seedFinalization(tenant.term.id, rows);
    await seedFinalization(null, rows);

    const field = await call<{ id: string }>(
      "POST",
      "/api/record-templates/student/fields",
      adminAuth(),
      {
        field_type: "short_text",
        label_en: "National ID",
        label_ar: "الرقم الوطني",
        sensitivity: "sensitive",
      },
    );
    expect(field.status).toBe(201);
    ids.nationalIdField = field.body.id;
    expect((await call("POST", "/api/record-templates/student/publish", adminAuth())).status).toBe(
      201,
    );
    const filled = await call("PUT", `/api/students/${ids.amal}/records`, adminAuth(), {
      answers: [{ field_id: ids.nationalIdField, value: NATIONAL_ID }],
    });
    expect(filled.status).toBe(200);
  });

  test("lists the built-in examples, marked as examples", async () => {
    const examples = await call<{ examples: { key: string; name_en: string }[] }>(
      "GET",
      "/api/grading/ministry-export-examples",
      adminAuth(),
    );
    expect(examples.status).toBe(200);
    expect(examples.body.examples.map((example) => example.key)).toEqual([
      "results_by_subject",
      "overall_results",
      "arabic_headings",
    ]);
    expect(examples.body.examples.every((example) => example.name_en.includes("(example)"))).toBe(
      true,
    );
  });

  test("leadership adds a template; its rules are checked", async () => {
    const created = await call<MinistryExportTemplateView>(
      "POST",
      TEMPLATES,
      adminAuth(),
      templateBody(),
    );
    expect(created.status).toBe(201);
    bySubject = created.body;
    expect(bySubject).toMatchObject({
      name: "Jordan MoE",
      file_format: "csv",
      encoding: "utf8_bom",
      row_kind: "subject",
      decimal_places: 1,
      national_id_field: { id: ids.nationalIdField, label_en: "National ID", sensitive: true },
      subject_codes: [{ subject_id: ids.math, subject_code: "MATH", code: "M-101" }],
    });
    expect(bySubject.columns.map((column) => column.field)).toEqual([
      "constant",
      "national_id",
      "full_name",
      "section",
      "subject_ministry_code",
      "mark",
      "grade_label",
      "status",
    ]);
    expect(bySubject.columns[7]!.value_map).toEqual([
      { from: "pass", to: "1" },
      { from: "fail", to: "2" },
    ]);

    const [audit] = await db.sql<{ action: string; new_values: Record<string, unknown> }[]>`
      SELECT action::text, new_values FROM app.audit_logs
      WHERE school_id = ${tenant.schoolId}::uuid AND target_table = 'ministry_export_templates'
        AND target_id = ${bySubject.id}::uuid
    `;
    expect(audit).toMatchObject({ action: "insert", new_values: { name: "Jordan MoE" } });

    expect((await call("POST", TEMPLATES, adminAuth(), templateBody())).status).toBe(409);
    // Subject fields need subject rows.
    expect(
      (
        await call(
          "POST",
          TEMPLATES,
          adminAuth(),
          templateBody({ name: "Overall", row_kind: "overall" }),
        )
      ).status,
    ).toBe(400);
    // A subject or a record field of another school is not found.
    expect(
      (
        await call(
          "POST",
          TEMPLATES,
          adminAuth(),
          templateBody({
            name: "Other",
            subject_codes: [{ subject_id: ids.otherSubject, code: "1" }],
          }),
        )
      ).status,
    ).toBe(404);
    expect(
      (await call("POST", TEMPLATES, otherAdminAuth(), templateBody({ subject_codes: [] }))).status,
    ).toBe(404);
  });

  test("only leadership reaches templates and exports", async () => {
    expect((await call("GET", TEMPLATES, teacherAuth())).status).toBe(403);
    expect((await call("POST", TEMPLATES, teacherAuth(), templateBody({ name: "T" }))).status).toBe(
      403,
    );
    expect((await call("POST", PREVIEW, teacherAuth(), run())).status).toBe(403);
    expect((await call("POST", DOWNLOAD, teacherAuth(), run())).status).toBe(403);
    // Browser sessions only, like the records reveal.
    const mobile = await call<{ code: string }>(
      "POST",
      DOWNLOAD,
      { ...adminAuth(), channel: "mobile" },
      run(),
    );
    expect([mobile.status, mobile.body.code]).toEqual([403, "CHANNEL_NOT_AUTHORIZED"]);
    expect(
      (await call("GET", "/api/grading/ministry-export-examples", auth(ids.amal!, "STUDENT")))
        .status,
    ).toBe(403);
    const principalList = await call<{ templates: { id: string }[] }>(
      "GET",
      TEMPLATES,
      principalAuth(),
    );
    expect(principalList.status).toBe(200);
    expect(principalList.body.templates.map((template) => template.id)).toEqual([bySubject.id]);
  });

  test("the preview shows the first rows with masked IDs and what to fix", async () => {
    const preview = await call<MinistryExportPreviewView>("POST", PREVIEW, adminAuth(), run());
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      template_id: bySubject.id,
      file_format: "csv",
      total_rows: 4,
      students: 2,
      sections_included: 1,
      national_ids_masked: true,
      header: [
        "School",
        "National ID",
        "Name",
        "Section",
        "Subject code",
        "Mark",
        "Grade",
        "Result",
      ],
    });
    expect(preview.body.rows.map((row) => row.cells)).toEqual([
      ["4412", "•••• 4567", "Amal Haddad", "10A", "", "40.0", "F", "2"],
      ["4412", "•••• 4567", "Amal Haddad", "10A", "M-101", "86.5", "B+", "1"],
      ["4412", "", "Badr Nasser", "10A", "", "55.0", "D", "1"],
      ["4412", "", "Badr Nasser", "10A", "M-101", "70.0", "C", "1"],
    ]);
    expect(
      preview.body.issues.map((issue) => [
        issue.code,
        issue.severity,
        issue.count,
        issue.student_name ?? issue.subject_code ?? issue.section_name,
      ]),
    ).toEqual([
      ["missing_national_id", "error", 2, "Badr Nasser"],
      ["unmapped_subject", "error", 2, "ART"],
      ["section_not_finalized", "warning", 0, "10B"],
    ]);
    // The preview never opens a sensitive value, so it audits nothing.
    const reveals = await db.sql`
      SELECT 1 FROM app.audit_logs
      WHERE school_id = ${tenant.schoolId}::uuid AND target_table = 'record_fields'
        AND action::text IN ('read', 'export')
    `;
    expect(reveals).toHaveLength(0);
  });

  test("the download has the full national IDs, audited as an export and a reveal", async () => {
    const response = await request("POST", DOWNLOAD, adminAuth(), run());
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("Content-Disposition")).toContain("jordan-moe-");
    const bytes = new Uint8Array(await response.arrayBuffer());
    // The UTF-8 byte-order mark (text() would strip it).
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = new TextDecoder().decode(bytes).trimEnd().split("\r\n");
    expect(lines).toEqual([
      "School,National ID,Name,Section,Subject code,Mark,Grade,Result",
      `4412,${NATIONAL_ID},Amal Haddad,10A,,40.0,F,2`,
      `4412,${NATIONAL_ID},Amal Haddad,10A,M-101,86.5,B+,1`,
      "4412,,Badr Nasser,10A,,55.0,D,1",
      "4412,,Badr Nasser,10A,M-101,70.0,C,1",
    ]);

    const audits = await db.sql<
      { action: string; target_table: string; new_values: Record<string, unknown> }[]
    >`
      SELECT action::text, target_table, new_values FROM app.audit_logs
      WHERE school_id = ${tenant.schoolId}::uuid AND action::text IN ('read', 'export')
        AND target_table IN ('record_fields', 'ministry_export_templates')
      ORDER BY action::text DESC
    `;
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({
      action: "read",
      target_table: "record_fields",
      new_values: {
        field_id: ids.nationalIdField,
        subject_ids: [ids.amal],
        reveal: true,
        purpose: "ministry_export",
      },
    });
    expect(audits[1]).toMatchObject({
      action: "export",
      target_table: "ministry_export_templates",
      new_values: { rows: 4, students: 2, sensitive_national_ids_opened: 1 },
    });
    // The value itself is never in an audit row.
    expect(JSON.stringify(audits)).not.toContain(NATIONAL_ID);

    // The principal holds studentRecord:readSensitive too.
    expect((await request("POST", DOWNLOAD, principalAuth(), run())).status).toBe(200);
  });

  test("an overall template exports the year's results as XLSX", async () => {
    const overall = await call<MinistryExportTemplateView>(
      "POST",
      TEMPLATES,
      adminAuth(),
      templateBody({
        name: "Overall results",
        file_format: "xlsx",
        row_kind: "overall",
        decimal_places: 2,
        national_id_field_id: null,
        subject_codes: [],
        columns: [
          { header: "Student number", field: "admission_number" },
          { header: "Term", field: "term", value_map: [{ from: "Annual", to: "3" }] },
          { header: "Average", field: "percentage" },
          { header: "Result", field: "status" },
        ],
      }),
    );
    expect(overall.status).toBe(201);
    const response = await request(
      "POST",
      DOWNLOAD,
      adminAuth(),
      run({ template_id: overall.body.id, term_id: null, grade_level_ids: [] }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("spreadsheetml");
    const { default: ExcelJS } = await import("exceljs");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await response.arrayBuffer());
    const sheet = workbook.getWorksheet("Results")!;
    expect(sheet.getRow(1).values).toEqual([
      undefined,
      "Student number",
      "Term",
      "Average",
      "Result",
    ]);
    expect(sheet.getRow(2).getCell(2).value).toBe("3");
    expect(sheet.getRow(2).getCell(3).value).toBe(63.2);
    expect(sheet.getRow(2).getCell(4).value).toBe("promoted");
    expect(sheet.rowCount).toBe(3);
  });

  test("an unknown term or a section of another year is not found", async () => {
    expect(
      (await call("POST", PREVIEW, adminAuth(), run({ term_id: crypto.randomUUID() }))).status,
    ).toBe(404);
    expect(
      (await call("POST", PREVIEW, adminAuth(), run({ section_ids: [crypto.randomUUID()] })))
        .status,
    ).toBe(404);
  });

  test("another school sees none of it", async () => {
    const list = await call<{ templates: unknown[] }>("GET", TEMPLATES, otherAdminAuth());
    expect(list.body.templates).toEqual([]);
    const path = `${TEMPLATES}/${bySubject.id}`;
    expect(
      (
        await call(
          "PUT",
          path,
          otherAdminAuth(),
          templateBody({ subject_codes: [], national_id_field_id: null }),
        )
      ).status,
    ).toBe(404);
    expect((await call("DELETE", path, otherAdminAuth())).status).toBe(404);
    expect(
      (
        await call("POST", PREVIEW, otherAdminAuth(), {
          ...run(),
          academic_year_id: otherTenant.academicYear.id,
          term_id: null,
          grade_level_ids: [],
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call("POST", DOWNLOAD, otherAdminAuth(), {
          ...run(),
          academic_year_id: otherTenant.academicYear.id,
          term_id: null,
          grade_level_ids: [],
        })
      ).status,
    ).toBe(404);
  });

  test("saving replaces the columns and codes; deleting removes the template", async () => {
    const path = `${TEMPLATES}/${bySubject.id}`;
    const updated = await call<MinistryExportTemplateView>(
      "PUT",
      path,
      adminAuth(),
      templateBody({
        columns: [{ header: "No.", field: "admission_number" }],
        subject_codes: [{ subject_id: ids.art, code: "A-9" }],
      }),
    );
    expect(updated.status).toBe(200);
    expect(updated.body.columns).toEqual([
      { header: "No.", field: "admission_number", constant_value: null, value_map: [] },
    ]);
    expect(updated.body.subject_codes.map((code) => code.code)).toEqual(["A-9"]);
    expect((await call("DELETE", path, adminAuth())).status).toBe(204);
    expect((await call("DELETE", path, adminAuth())).status).toBe(404);
    const [left] = await db.sql<{ n: number }[]>`
      SELECT (SELECT count(*) FROM app.ministry_export_columns WHERE template_id = ${bySubject.id}::uuid)
           + (SELECT count(*) FROM app.ministry_export_subject_codes WHERE template_id = ${bySubject.id}::uuid)
             AS n
    `;
    expect(Number(left!.n)).toBe(0);
  });
});
