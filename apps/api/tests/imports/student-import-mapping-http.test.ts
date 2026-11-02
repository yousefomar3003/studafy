/**
 * Student CSV column mapping, staging and dry-run diff over HTTP (ST-299).
 *
 * Full path: JWT auth, web channel guard, STUDENT_IMPORT permission, tenant transaction with RLS
 * armed. The staging-to-target migration itself is the worker's, and is covered by
 * apps/workers/src/queues/imports/worker.test.ts. Requires a live PostgreSQL instance, gated on
 * TEST_DATABASE_URL like every other integration suite.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/imports/student-import-mapping-http.test.ts
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

interface Tenant {
  schoolId: string;
  userId: string;
  slug: string;
}

async function createTenant(): Promise<Tenant> {
  const school = await createSchool(database!.sql);
  const admin = await createUser(database!.sql, school.id);
  await assignRole(database!.sql, school.id, admin.id, "ORG_ADMIN");
  return { schoolId: school.id, userId: admin.id, slug: school.slug };
}

function request(tenant: Tenant, method: string, path: string, init?: RequestInit) {
  return authenticatedRequest(
    harness!,
    method,
    path,
    { schoolId: tenant.schoolId, userId: tenant.userId, channel: AUTH_CHANNELS.WEB },
    init,
  );
}

function upload(tenant: Tenant, csv: string, mappingId?: string) {
  const query = mappingId ? `?mapping_id=${mappingId}` : "";
  return request(tenant, "POST", `/api/imports/students/upload${query}`, {
    headers: { "Content-Type": "text/csv", "X-File-Name": "sis-export.csv" },
    body: csv,
  });
}

function json(body: unknown): RequestInit {
  return { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

async function auditTables(tenant: Tenant): Promise<string[]> {
  return database!.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${tenant.schoolId}, true)`;
    const rows = await tx<{ entry: string }[]>`
      SELECT action::text || ' ' || target_table AS entry
      FROM app.audit_logs
      WHERE school_id = ${tenant.schoolId}::uuid
    `;
    // Sorted: rows written in one transaction share created_at, so their order is not meaningful.
    return rows.map((row) => row.entry).sort();
  }) as Promise<string[]>;
}

const UNRECOGNISED_CSV = [
  "Code,Mail,Given,Family",
  "S-1,s1@example.edu,Sam,One",
  "S-2,s2@example.edu,Sue,Two",
].join("\n");

describeDb("student import mapping HTTP", () => {
  test("detects the header row under title lines and maps renamed, reordered headers", async () => {
    const tenant = await createTenant();
    const csv = [
      "Term 1 export",
      "Surname,Given Name,Student ID,E-mail,DOB",
      "Doe,Jane,NEW-1,jane@example.edu,2010-03-15",
    ].join("\n");

    const res = await upload(tenant, csv);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      status: "validated",
      header_line: 2,
      source_headers: ["Surname", "Given Name", "Student ID", "E-mail", "DOB"],
      column_mapping: {
        last_name: "Surname",
        first_name: "Given Name",
        admission_number: "Student ID",
        email: "E-mail",
        date_of_birth: "DOB",
      },
      row_count: 1,
      valid_rows: 1,
      error_rows: 0,
      errors: [],
    });
  });

  test("an unrecognised layout is re-mapped in place, saved, and reused by a later upload", async () => {
    const tenant = await createTenant();

    const first = (await (await upload(tenant, UNRECOGNISED_CSV)).json()) as {
      id: string;
      status: string;
      valid_rows: number;
      errors: { line: number; field: string }[];
    };
    expect(first.status).toBe("uploaded");
    expect(first.valid_rows).toBe(0);
    // None of these headers is a known spelling, so nothing required is mapped.
    expect(first.errors.map((e) => e.field).sort()).toEqual([
      "admission_number",
      "email",
      "first_name",
      "last_name",
    ]);

    const mapping = {
      admission_number: "Code",
      email: "Mail",
      first_name: "Given",
      last_name: "Family",
    };
    const remapped = await request(
      tenant,
      "PUT",
      `/api/imports/students/${first.id}/mapping`,
      json({ column_mapping: mapping, save_as: "Legacy SIS" }),
    );
    expect(remapped.status).toBe(200);
    expect(await remapped.json()).toMatchObject({
      status: "validated",
      valid_rows: 2,
      errors: [],
      column_mapping: mapping,
    });

    const list = (await (
      await request(tenant, "GET", "/api/imports/students/mappings")
    ).json()) as {
      mappings: { id: string; name: string; column_mapping: unknown }[];
    };
    expect(list.mappings).toHaveLength(1);
    expect(list.mappings[0]).toMatchObject({ name: "Legacy SIS", column_mapping: mapping });

    const second = await upload(tenant, UNRECOGNISED_CSV, list.mappings[0]!.id);
    expect(await second.json()).toMatchObject({ status: "validated", valid_rows: 2 });

    expect(await auditTables(tenant)).toEqual([
      "insert student_import_mappings",
      "insert student_imports",
      "insert student_imports",
      "update student_imports",
    ]);
  });

  test("the dry-run diff shows creates, updates and conflicts before commit", async () => {
    const tenant = await createTenant();
    await createStudent(database!.sql, tenant.schoolId, {
      admissionNumber: "OLD-1",
      email: `old@${tenant.slug}.local`,
      firstName: "Old",
      lastName: "Name",
    });
    await createStudent(database!.sql, tenant.schoolId, {
      admissionNumber: "OLD-2",
      email: `other@${tenant.slug}.local`,
    });

    const csv = [
      "Student ID,E-mail,First Name,Last Name,Status",
      `NEW-1,new@${tenant.slug}.local,New,Kid,applicant`,
      `OLD-1,old@${tenant.slug}.local,Renamed,Name,enrolled`,
      `OLD-2,changed@${tenant.slug}.local,Test,Student,enrolled`,
    ].join("\n");
    const staged = (await (await upload(tenant, csv)).json()) as { id: string };

    const res = await request(tenant, "GET", `/api/imports/students/${staged.id}/diff`);
    expect(res.status).toBe(200);
    const diff = (await res.json()) as {
      totals: Record<string, number>;
      rows: { line_number: number; action: string; conflict: string | null; changes: unknown }[];
    };
    expect(diff.totals).toMatchObject({ create: 1, update: 1, unchanged: 0, conflict: 1 });
    expect(diff.rows).toEqual([
      expect.objectContaining({ line_number: 2, action: "create", conflict: null }),
      expect.objectContaining({
        line_number: 3,
        action: "update",
        changes: { first_name: { from: "Old", to: "Renamed" } },
      }),
      expect.objectContaining({ line_number: 4, action: "conflict", conflict: "EMAIL_MISMATCH" }),
    ]);

    const conflictsOnly = (await (
      await request(tenant, "GET", `/api/imports/students/${staged.id}/diff?action=conflict`)
    ).json()) as { totals: Record<string, number>; rows: unknown[] };
    expect(conflictsOnly.rows).toHaveLength(1);
    expect(conflictsOnly.totals.create).toBe(1);

    const confirmed = await request(
      tenant,
      "POST",
      `/api/imports/students/${staged.id}/confirm`,
      json({}),
    );
    expect(await confirmed.json()).toMatchObject({
      status: "confirmed",
      confirmed_by: tenant.userId,
    });

    const late = await request(
      tenant,
      "PUT",
      `/api/imports/students/${staged.id}/mapping`,
      json({
        column_mapping: {
          admission_number: "Student ID",
          email: "E-mail",
          first_name: "First Name",
          last_name: "Last Name",
        },
      }),
    );
    expect(late.status).toBe(409);
  });

  test("saved mappings are validated, unique per school, and deletable", async () => {
    const tenant = await createTenant();
    const complete = {
      admission_number: "ID",
      email: "Mail",
      first_name: "First",
      last_name: "Last",
    };

    const incomplete = await request(
      tenant,
      "POST",
      "/api/imports/students/mappings",
      json({ name: "Partial", column_mapping: { admission_number: "ID" } }),
    );
    expect(incomplete.status).toBe(400);

    const unknownField = await request(
      tenant,
      "POST",
      "/api/imports/students/mappings",
      json({ name: "Bad", column_mapping: { ...complete, shoe_size: "Shoes" } }),
    );
    expect(unknownField.status).toBe(400);

    const created = await request(
      tenant,
      "POST",
      "/api/imports/students/mappings",
      json({ name: "District export", column_mapping: complete }),
    );
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    const duplicate = await request(
      tenant,
      "POST",
      "/api/imports/students/mappings",
      json({ name: "  district EXPORT ", column_mapping: complete }),
    );
    expect(duplicate.status).toBe(409);

    const renamed = await request(
      tenant,
      "PATCH",
      `/api/imports/students/mappings/${id}`,
      json({ name: "District export v2" }),
    );
    expect(await renamed.json()).toMatchObject({
      name: "District export v2",
      column_mapping: complete,
    });

    // Another school cannot see or use it.
    const other = await createTenant();
    expect((await upload(other, UNRECOGNISED_CSV, id)).status).toBe(404);

    expect((await request(tenant, "DELETE", `/api/imports/students/mappings/${id}`)).status).toBe(
      204,
    );
    expect((await request(tenant, "DELETE", `/api/imports/students/mappings/${id}`)).status).toBe(
      404,
    );

    expect(await auditTables(tenant)).toEqual([
      "delete student_import_mappings",
      "insert student_import_mappings",
      "update student_import_mappings",
    ]);
  });
  test("the import list pages with next_cursor", async () => {
    const tenant = await createTenant();
    for (let i = 0; i < 3; i++) await upload(tenant, UNRECOGNISED_CSV);

    const first = (await (
      await request(tenant, "GET", "/api/imports/students?limit=2")
    ).json()) as { imports: unknown[]; next_cursor: string | null };
    expect(first.imports).toHaveLength(2);
    expect(first.next_cursor).not.toBeNull();

    const second = (await (
      await request(
        tenant,
        "GET",
        `/api/imports/students?limit=2&cursor=${encodeURIComponent(first.next_cursor!)}`,
      )
    ).json()) as { imports: unknown[]; next_cursor: string | null };
    expect(second.imports).toHaveLength(1);
    expect(second.next_cursor).toBeNull();
  });
});
