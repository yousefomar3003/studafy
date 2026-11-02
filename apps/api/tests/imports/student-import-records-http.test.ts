/**
 * Student CSV import with student record template columns, and the end of parent matching by email
 * (docs/modules/student-records.md "CSV import"; finance-module-guide.md "How parents and children
 * get linked"). The preview over HTTP: template columns mapped by label, sensitive cells masked and
 * never echoed in errors, a parent_email that belongs to an existing account reported as
 * PARENT_ACCOUNT_EXISTS (the student still imports, unlinked), and siblings sharing one new parent
 * grouped before confirm. The worker's apply is covered by apps/workers' worker.test.ts.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/imports/student-import-records-http.test.ts
 */
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

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

interface Tenant {
  schoolId: string;
  userId: string;
  slug: string;
}

const SECRET = "784-1990-1234567-1";

async function createTenant(): Promise<Tenant> {
  const school = await createSchool(database!.sql);
  const admin = await createUser(database!.sql, school.id);
  await assignRole(database!.sql, school.id, admin.id, "ORG_ADMIN");
  return { schoolId: school.id, userId: admin.id, slug: school.slug };
}

function request(tenant: Tenant, method: string, path: string, body?: unknown, csv?: string) {
  return authenticatedRequest(
    harness!,
    method,
    path,
    { schoolId: tenant.schoolId, userId: tenant.userId, channel: AUTH_CHANNELS.WEB },
    csv !== undefined
      ? { headers: { "Content-Type": "text/csv", "X-File-Name": "sis.csv" }, body: csv }
      : body === undefined
        ? undefined
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
}

async function field(tenant: Tenant, body: Record<string, unknown>): Promise<string> {
  const res = await request(tenant, "POST", "/api/record-templates/student/fields", {
    label_ar: "حقل",
    ...body,
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

interface DiffRow {
  line_number: number;
  admission_number: string;
  action: string;
  parent: string | null;
  parent_conflict: string | null;
  parent_group_line: number | null;
  link: string | null;
  records: {
    field_id: string;
    label_en: string;
    label_ar: string;
    value: unknown;
    mask: string | null;
  }[];
}

describeDb("student import with record template columns", () => {
  test("maps, masks, reports PARENT_ACCOUNT_EXISTS and groups siblings before confirm", async () => {
    const tenant = await createTenant();
    const busStop = await field(tenant, { field_type: "short_text", label_en: "Bus stop" });
    const nationalId = await field(tenant, {
      field_type: "short_text",
      label_en: "National ID",
      sensitivity: "sensitive",
    });
    expect((await request(tenant, "POST", "/api/record-templates/student/publish")).status).toBe(
      201,
    );

    const existing = await createUser(database!.sql, tenant.schoolId, {
      email: `parent@${tenant.slug}.local`,
    });
    await assignRole(database!.sql, tenant.schoolId, existing.id, "PARENT");

    const csv = [
      "Surname,Given Name,Student ID,E-mail,Guardian Email,Relationship,Bus stop,National ID",
      `Haddad,Rana,S-1,rana@${tenant.slug}.local,dad@${tenant.slug}.local,father,Gate 3,${SECRET}`,
      `Haddad,Omar,S-2,omar@${tenant.slug}.local,dad@${tenant.slug}.local,father,Gate 3,`,
      `Saleh,Huda,S-3,huda@${tenant.slug}.local,parent@${tenant.slug}.local,mother,,`,
    ].join("\n");
    const uploaded = await request(tenant, "POST", "/api/imports/students/upload", undefined, csv);
    expect(uploaded.status).toBe(201);
    const uploadText = await uploaded.text();
    expect(uploadText).not.toContain(SECRET);
    const record = JSON.parse(uploadText) as {
      id: string;
      status: string;
      column_mapping: { records?: Record<string, string> };
    };
    expect(record.status).toBe("validated");
    expect(record.column_mapping.records).toEqual({
      [busStop]: "Bus stop",
      [nationalId]: "National ID",
    });

    const diffRes = await request(tenant, "GET", `/api/imports/students/${record.id}/diff`);
    expect(diffRes.status).toBe(200);
    const diffText = await diffRes.text();
    expect(diffText).not.toContain(SECRET);
    const diff = JSON.parse(diffText) as { totals: Record<string, number>; rows: DiffRow[] };

    expect(diff.totals).toMatchObject({
      create: 3,
      parents_created: 1,
      links_created: 2,
      parent_conflicts: 1,
    });
    const [rana, omar, huda] = diff.rows;
    expect(rana).toMatchObject({ parent: "create", parent_group_line: 2, link: "create" });
    expect(omar).toMatchObject({ parent: "sibling", parent_group_line: 2, link: "create" });
    expect(huda).toMatchObject({
      action: "create",
      parent: "conflict",
      parent_conflict: "PARENT_ACCOUNT_EXISTS",
      link: null,
    });
    expect(rana!.records).toEqual([
      { field_id: busStop, label_en: "Bus stop", label_ar: "حقل", value: "Gate 3", mask: null },
      {
        field_id: nationalId,
        label_en: "National ID",
        label_ar: "حقل",
        value: null,
        mask: "•••• 67-1",
      },
    ]);
  });

  test("a document field is refused and a bad sensitive cell is reported without its value", async () => {
    const tenant = await createTenant();
    const certificate = await field(tenant, {
      field_type: "document",
      label_en: "Birth certificate",
    });
    const phone = await field(tenant, {
      field_type: "phone",
      label_en: "Emergency phone",
      sensitivity: "sensitive",
    });
    await request(tenant, "POST", "/api/record-templates/student/publish");

    const csv = [
      "Surname,Given Name,Student ID,E-mail,Emergency phone,Birth certificate",
      `Doe,Jane,D-1,jane@${tenant.slug}.local,call-me-SECRET42,scan.pdf`,
    ].join("\n");
    const uploaded = (await (
      await request(tenant, "POST", "/api/imports/students/upload", undefined, csv)
    ).json()) as { id: string; errors: { line: number; field: string; message: string }[] };
    expect(uploaded.errors).toEqual([
      {
        line: 2,
        field: `record:${phone}`,
        message: '"Emergency phone": Not a valid phone number.',
      },
    ]);
    expect(JSON.stringify(uploaded)).not.toContain("SECRET42");

    const remapped = await request(tenant, "PUT", `/api/imports/students/${uploaded.id}/mapping`, {
      column_mapping: {
        last_name: "Surname",
        first_name: "Given Name",
        admission_number: "Student ID",
        email: "E-mail",
        records: { [certificate]: "Birth certificate" },
      },
    });
    expect(remapped.status).toBe(200);
    const body = (await remapped.json()) as {
      errors: { line: number; field: string; message: string }[];
    };
    expect(body.errors).toEqual([
      {
        line: 1,
        field: `record:${certificate}`,
        message: '"Birth certificate" is a document field: upload its files on the Records tab.',
      },
    ]);
  });
});
