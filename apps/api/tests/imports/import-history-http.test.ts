/**
 * Student import history, original files and unmapped columns over HTTP, against the real test
 * database (docs/modules/student-import-mapping-guide.md "Import history and unmapped columns").
 *
 * Proves: the original file is kept only when its stored bytes are the bytes parsed, promoted under
 * the sensitive key and charged to the school; downloads are short-lived and audited; deletion
 * forgets the file and removes the object; unmapped columns are listed with server-side type and
 * sensitivity suggestions; a column is written only after a preview whose token still matches,
 * through the records save path (validation, sealing, audit, the missing-information list), and only
 * to the people the import itself wrote -- never to anyone matched by a value in the file; and the
 * platform signal shows header text and counts only. The worker's half (which cells it keeps) is
 * covered by apps/workers' worker.test.ts; here the completion is seeded the way it leaves rows.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/imports/import-history-http.test.ts
 */
import { createHash } from "node:crypto";

import { DEVELOPMENT_RECORD_KEYRING, openRecordValue } from "@studafy/records";
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

import type { StorageService } from "../../src/lib/storage";
import type { UploadScanRequest } from "../../src/lib/storage/upload-scan";
import type { TestApp, TestDatabase } from "../harness";
import type { Role } from "@studafy/constants";
import type { TransactionSql } from "postgres";

const describeDb = integrationEnabled ? describe : describe.skip;

interface StoredObject {
  contentType: string;
  sizeBytes: number;
  body: Uint8Array;
}

/** In-memory bucket that hashes what was really "uploaded", so the checksum check is real. */
function fakeStorage() {
  const objects = new Map<string, StoredObject>();
  const sensitiveCopies: string[] = [];
  const presigned: { key: string; ttl: number | undefined }[] = [];
  const service: StorageService = {
    ttlSeconds: 900,
    check: async () => true,
    presign(key, _method, _contentType, ttl) {
      presigned.push({ key, ttl });
      return {
        url: `https://storage.example/${encodeURIComponent(key)}?signed`,
        expiresAt: new Date(Date.now() + (ttl ?? 900) * 1000),
      };
    },
    exists: async (key) => objects.has(key),
    size: async (key) => objects.get(key)?.sizeBytes ?? 0,
    async head(key) {
      const object = objects.get(key);
      return object ? { contentType: object.contentType, sizeBytes: object.sizeBytes } : null;
    },
    async checksumSha256(key) {
      return createHash("sha256")
        .update(objects.get(key)?.body ?? new Uint8Array())
        .digest("hex");
    },
    async copy(source, destination, options) {
      const object = objects.get(source);
      if (object) objects.set(destination, { ...object });
      if (options?.sensitive) sensitiveCopies.push(destination);
    },
    async remove(key) {
      objects.delete(key);
    },
    async *list(prefix) {
      for (const [key, object] of objects) {
        if (key.startsWith(prefix)) yield { key, sizeBytes: object.sizeBytes };
      }
    },
  };
  return Object.assign(service, { objects, sensitiveCopies, presigned });
}

const storage = fakeStorage();
let database: TestDatabase | undefined;
let harness: TestApp | undefined;
/** Every malware scan the app enqueued (F-14). */
const scanJobs: UploadScanRequest[] = [];

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  const created = createTestApp({
    database: database.sql,
    storage,
    uploadScanEnqueuer: async (requests) => {
      scanJobs.push(...requests);
    },
  });
  await created.ready;
  harness = created;
}, 120_000);

afterAll(async () => {
  harness?.keyStore.destroy();
  await database?.cleanup();
});

interface Actor {
  schoolId: string;
  userId: string;
  roles?: Role[];
}

interface Tenant {
  schoolId: string;
  slug: string;
  admin: Actor;
}

async function createTenant(): Promise<Tenant> {
  const school = await createSchool(database!.sql);
  const admin = await createUser(database!.sql, school.id, { displayName: "Amal Admin" });
  await assignRole(database!.sql, school.id, admin.id, "ORG_ADMIN");
  return {
    schoolId: school.id,
    slug: school.slug,
    admin: { schoolId: school.id, userId: admin.id },
  };
}

async function actor(tenant: Tenant, role: Role): Promise<Actor> {
  const user = await createUser(database!.sql, tenant.schoolId);
  await assignRole(database!.sql, tenant.schoolId, user.id, role);
  return { schoolId: tenant.schoolId, userId: user.id, roles: [role] };
}

function call(who: Actor, method: string, path: string, body?: unknown, csv?: string) {
  return authenticatedRequest(
    harness!,
    method,
    path,
    { schoolId: who.schoolId, userId: who.userId, roles: who.roles, channel: AUTH_CHANNELS.WEB },
    csv !== undefined
      ? { headers: { "Content-Type": "text/csv", "X-File-Name": "sis.csv" }, body: csv }
      : body === undefined
        ? undefined
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function asSchool<T>(schoolId: string, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return database!.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

/** Stage the file through the gateway the way the web client does; returns the temp key. */
async function stageSource(who: Actor, csv: string, contentClass = "import.source") {
  const body = new TextEncoder().encode(csv);
  const response = await call(who, "POST", "/api/storage/uploads/request-upload", {
    content_class: contentClass,
    file_name: "sis.csv",
    content_type: "text/csv",
    size_bytes: body.byteLength,
  });
  expect([200, 201]).toContain(response.status);
  const { storage_key } = await json<{ storage_key: string }>(response);
  storage.objects.set(storage_key, { contentType: "text/csv", sizeBytes: body.byteLength, body });
  return storage_key;
}

interface ImportDto {
  id: string;
  status: string;
  source_file: {
    file_name: string;
    size_bytes: number | null;
    stored: boolean;
    expires_at: string | null;
    removed_reason: string | null;
  } | null;
}

async function upload(tenant: Tenant, csv: string, sourceKey?: string) {
  const query = sourceKey ? `?source_key=${encodeURIComponent(sourceKey)}` : "";
  return call(tenant.admin, "POST", `/api/imports/students/upload${query}`, undefined, csv);
}

async function field(tenant: Tenant, kind: "student" | "parent", body: Record<string, unknown>) {
  const response = await call(tenant.admin, "POST", `/api/record-templates/${kind}/fields`, {
    label_ar: "حقل",
    ...body,
  });
  expect(response.status).toBe(201);
  return (await json<{ id: string }>(response)).id;
}

async function publish(tenant: Tenant, kind: "student" | "parent") {
  expect((await call(tenant.admin, "POST", `/api/record-templates/${kind}/publish`)).status).toBe(
    201,
  );
}

/**
 * Confirm the import, then leave it as the worker does on completion: each line's student created,
 * siblings sharing one new parent, every line tagged with whom it wrote, status completed.
 */
async function confirmAndComplete(tenant: Tenant, importId: string) {
  expect(
    (await call(tenant.admin, "POST", `/api/imports/students/${importId}/confirm`, {})).status,
  ).toBe(200);
  const rows = await asSchool(
    tenant.schoolId,
    (tx) =>
      tx<
        { line_number: number; record: { admission_number: string; parent_email: string | null } }[]
      >`
      SELECT line_number, record FROM app.student_import_rows
      WHERE import_id = ${importId}::uuid AND record IS NOT NULL ORDER BY line_number
    `,
  );
  const parents = new Map<string, string>();
  const written: { line: number; studentId: string; parentId: string | null }[] = [];
  for (const row of rows) {
    const student = await createStudent(database!.sql, tenant.schoolId, {
      admissionNumber: row.record.admission_number,
      firstName: `First${row.line_number}`,
    });
    let parentId: string | null = null;
    if (row.record.parent_email) {
      parentId = parents.get(row.record.parent_email) ?? null;
      if (!parentId) {
        const parent = await createUser(database!.sql, tenant.schoolId, {
          displayName: `Parent of line ${row.line_number}`,
        });
        await assignRole(database!.sql, tenant.schoolId, parent.id, "PARENT");
        parentId = parent.id;
        parents.set(row.record.parent_email, parentId);
      }
    }
    written.push({ line: row.line_number, studentId: student.id, parentId });
  }
  await asSchool(tenant.schoolId, async (tx) => {
    for (const line of written) {
      await tx`
        UPDATE app.student_import_rows
        SET student_id = ${line.studentId}::uuid, parent_user_id = ${line.parentId}::uuid,
            record = NULL
        WHERE import_id = ${importId}::uuid AND line_number = ${line.line}
      `;
    }
    await tx`
      UPDATE app.student_imports
      SET status = 'completed', completed_at = now(),
          summary = '{"students_created": 0, "students_skipped": 0, "parents_created": 0, "parents_linked": 0}'::jsonb
      WHERE id = ${importId}::uuid
    `;
  });
  return written;
}

function csvFor(slug: string) {
  return [
    "Student ID,First,Last,Email,Guardian Email,Relationship,Civil ID,House,Allergic?,Bus stop",
    `S-1,Rana,Haddad,rana@${slug}.local,dad@${slug}.local,father,289010112345,Red,yes,Gate 3`,
    `S-2,Omar,Haddad,omar@${slug}.local,dad@${slug}.local,father,301020254321,Blue,no,Gate 4`,
    `S-3,Huda,Saleh,huda@${slug}.local,,,290030398765,Red,maybe,`,
    `S-4,Sami,Saleh,sami@${slug}.local,,,,Blue,no,Gate 3`,
  ].join("\n");
}

describeDb("original import files", () => {
  test("keeps the exact bytes parsed, under the sensitive key, and audits each download", async () => {
    const tenant = await createTenant();
    const csv = csvFor(tenant.slug);
    const key = await stageSource(tenant.admin, csv);

    const uploaded = await upload(tenant, csv, key);
    expect(uploaded.status).toBe(201);
    const record = await json<ImportDto>(uploaded);
    expect(record.source_file).toMatchObject({
      file_name: "sis.csv",
      size_bytes: new TextEncoder().encode(csv).byteLength,
      stored: true,
      removed_reason: null,
    });
    // 180 days by default.
    const expires = new Date(record.source_file!.expires_at!).getTime();
    expect(Math.round((expires - Date.now()) / 86_400_000)).toBe(180);
    expect(storage.objects.has(key)).toBe(false); // promoted out of temp/
    expect(
      storage.sensitiveCopies.some((dest) => dest.startsWith(`permanent/${tenant.schoolId}/`)),
    ).toBe(true);

    // Not handed out until the malware scan clears it (F-14); then the worker's clean verdict.
    const sourcePath = `/api/imports/students/${record.id}/source`;
    expect((await call(tenant.admin, "GET", sourcePath)).status).toBe(404);
    const permanentKey = key.replace(/^temp\//, "permanent/");
    expect(scanJobs).toContainEqual({
      target: "import_source",
      schoolId: tenant.schoolId,
      storageKey: permanentKey,
    });
    await asSchool(tenant.schoolId, async (tx) => {
      await tx`
        UPDATE app.student_imports SET source_scan_status = 'clean'
        WHERE id = ${record.id}::uuid AND source_scan_status = 'scanning'
      `;
    });

    const download = await call(tenant.admin, "GET", sourcePath);
    expect(download.status).toBe(200);
    expect(download.headers.get("Cache-Control")).toBe("no-store");
    expect((await json<{ url: string }>(download)).url).toContain("storage.example");
    expect(storage.presigned.at(-1)?.ttl).toBe(60);
    const [audit] = await asSchool(
      tenant.schoolId,
      (tx) =>
        tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM app.audit_logs
        WHERE target_table = 'student_imports' AND target_id = ${record.id}::uuid
          AND action = 'read'
      `,
    );
    expect(audit!.n).toBe(1);

    // Deleting forgets the file, keeps the import, and removes the object after commit.
    const stored = [...storage.objects.keys()].find((k) =>
      k.startsWith(`permanent/${tenant.schoolId}/`),
    )!;
    const deleted = await call(tenant.admin, "DELETE", `/api/imports/students/${record.id}/source`);
    expect(deleted.status).toBe(204);
    expect(storage.objects.has(stored)).toBe(false);
    const after = await json<ImportDto>(
      await call(tenant.admin, "GET", `/api/imports/students/${record.id}`),
    );
    expect(after.source_file).toMatchObject({
      stored: false,
      removed_reason: "deleted",
      size_bytes: null,
    });
    const gone = await call(tenant.admin, "GET", `/api/imports/students/${record.id}/source`);
    expect(gone.status).toBe(404);
    expect((await json<{ code: string }>(gone)).code).toBe("IMPORT_SOURCE_NOT_FOUND");
  });

  test("refuses a staged file whose bytes differ from the body, and keeps nothing", async () => {
    const tenant = await createTenant();
    const key = await stageSource(tenant.admin, "Student ID,First,Last,Email\nS-9,A,B,a@b.co");
    const response = await upload(tenant, csvFor(tenant.slug), key);
    expect(response.status).toBe(400);
    expect((await json<{ code: string }>(response)).code).toBe("STORAGE_CHECKSUM_MISMATCH");
    const [count] = await asSchool(
      tenant.schoolId,
      (tx) => tx<{ n: number }[]>`SELECT count(*)::int AS n FROM app.student_imports`,
    );
    expect(count!.n).toBe(0);
  });

  test("refuses another school's staged key and the generic gateway confirm", async () => {
    const tenant = await createTenant();
    const other = await createTenant();
    const csv = csvFor(tenant.slug);
    const foreign = await stageSource(other.admin, csv);
    expect((await upload(tenant, csv, foreign)).status).toBe(403);

    const own = await stageSource(tenant.admin, csv);
    const confirm = await call(tenant.admin, "POST", "/api/storage/uploads/confirm", {
      content_class: "import.source",
      storage_key: own,
    });
    expect(confirm.status).toBeGreaterThanOrEqual(400);
  });

  test("lists imports newest first with who ran them; other schools see none of it", async () => {
    const tenant = await createTenant();
    const first = await json<ImportDto>(await upload(tenant, csvFor(tenant.slug)));
    const second = await json<ImportDto>(
      await upload(
        tenant,
        csvFor(tenant.slug),
        await stageSource(tenant.admin, csvFor(tenant.slug)),
      ),
    );
    const list = await json<{
      imports: (ImportDto & { uploaded_by_name: string; unmapped_column_count: number })[];
    }>(await call(tenant.admin, "GET", "/api/imports/students?limit=10"));
    expect(list.imports.map((item) => item.id)).toEqual([second.id, first.id]);
    expect(list.imports[0]!.uploaded_by_name).toBe("Amal Admin");
    expect(list.imports[0]!.unmapped_column_count).toBe(4);
    expect(list.imports[1]!.source_file).toBeNull();

    const other = await createTenant();
    expect(
      (await call(other.admin, "GET", `/api/imports/students/${second.id}/source`)).status,
    ).toBe(404);
    expect(
      (await call(other.admin, "GET", `/api/imports/students/${second.id}/columns`)).status,
    ).toBe(404);
  });

  test("retention can be shortened, never extended past 180 days", async () => {
    const tenant = await createTenant();
    expect(
      (
        await call(tenant.admin, "PUT", "/api/imports/students/settings", {
          source_retention_days: 181,
        })
      ).status,
    ).toBe(400);
    const set = await call(tenant.admin, "PUT", "/api/imports/students/settings", {
      source_retention_days: 30,
    });
    expect(set.status).toBe(200);
    expect((await json<{ source_retention_days: number }>(set)).source_retention_days).toBe(30);
    const record = await json<ImportDto>(
      await upload(
        tenant,
        csvFor(tenant.slug),
        await stageSource(tenant.admin, csvFor(tenant.slug)),
      ),
    );
    const days = (new Date(record.source_file!.expires_at!).getTime() - Date.now()) / 86_400_000;
    expect(Math.round(days)).toBe(30);
  });
});

interface ColumnsDto {
  can_apply: boolean;
  columns: {
    position: number;
    header: string;
    suggested_field_type: string;
    suggested_options: { value: string; label_en: string }[];
    suggested_sensitive: boolean;
    sensitive_reason: string | null;
    student_count: number;
    parent_count: number;
    applied: { field_id: string; count: number } | null;
  }[];
}

interface PreviewDto {
  totals: Record<string, number>;
  rows: {
    subject_id: string;
    status: string;
    value: unknown;
    mask: string | null;
    reason: string | null;
    replaces_existing: boolean;
  }[];
  preview_token: string;
}

describeDb("unmapped columns", () => {
  test("lists them with server-side suggestions; nothing applies before completion", async () => {
    const tenant = await createTenant();
    const record = await json<ImportDto>(await upload(tenant, csvFor(tenant.slug)));
    const columns = await json<ColumnsDto>(
      await call(tenant.admin, "GET", `/api/imports/students/${record.id}/columns`),
    );
    expect(columns.can_apply).toBe(false);
    const byHeader = new Map(columns.columns.map((column) => [column.header, column]));
    expect([...byHeader.keys()]).toEqual(["Civil ID", "House", "Allergic?", "Bus stop"]);
    expect(byHeader.get("Civil ID")).toMatchObject({
      suggested_field_type: "short_text",
      suggested_sensitive: true,
      sensitive_reason: "label",
    });
    expect(byHeader.get("House")!.suggested_field_type).toBe("single_choice");
    expect(byHeader.get("Bus stop")!.suggested_sensitive).toBe(false);

    const preview = await call(
      tenant.admin,
      "POST",
      `/api/imports/students/${record.id}/columns/preview`,
      {
        position: 9,
        subject_kind: "student",
        new_field: { label_en: "Bus stop", label_ar: "موقف", field_type: "short_text" },
      },
    );
    expect(preview.status).toBe(409);
    expect((await json<{ code: string }>(preview)).code).toBe("IMPORT_INVALID_STATE");
  });

  test("previews, then writes only after a matching confirm, through the records save path", async () => {
    const tenant = await createTenant();
    // A required field the column fills: the missing-information list must notice.
    const busStop = await field(tenant, "student", {
      field_type: "short_text",
      label_en: "Bus stop",
      required: true,
    });
    await publish(tenant, "student");
    // Someone already in the school with the same name and admission number pattern as a line of
    // the file: an import never matches people, so they must receive nothing.
    const bystander = await createStudent(database!.sql, tenant.schoolId, {
      admissionNumber: "OUTSIDE-1",
      firstName: "Rana",
      lastName: "Haddad",
    });

    // Map the Bus stop column away so it is left unmapped on purpose.
    const uploaded = await json<ImportDto & { column_mapping: Record<string, unknown> }>(
      await upload(
        tenant,
        csvFor(tenant.slug),
        await stageSource(tenant.admin, csvFor(tenant.slug)),
      ),
    );
    const mapping = { ...uploaded.column_mapping };
    delete (mapping as { records?: unknown }).records;
    const remapped = await call(
      tenant.admin,
      "PUT",
      `/api/imports/students/${uploaded.id}/mapping`,
      {
        column_mapping: mapping,
      },
    );
    expect(remapped.status).toBe(200);
    const written = await confirmAndComplete(tenant, uploaded.id);

    const missingBefore = await json<{ total: number }>(
      await call(tenant.admin, "GET", "/api/records/missing/students?issue=missing"),
    );

    const target = { position: 9, subject_kind: "student", field_id: busStop };
    const previewResponse = await call(
      tenant.admin,
      "POST",
      `/api/imports/students/${uploaded.id}/columns/preview`,
      target,
    );
    expect(previewResponse.status).toBe(200);
    const preview = await json<PreviewDto>(previewResponse);
    expect(preview.totals).toMatchObject({ write: 3, empty: 1, invalid: 0 });
    expect(preview.rows.map((row) => row.value).sort()).toEqual(["Gate 3", "Gate 3", "Gate 4"]);

    // Nothing written by the preview.
    const [none] = await asSchool(
      tenant.schoolId,
      (tx) =>
        tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM app.record_answers WHERE field_id = ${busStop}::uuid
      `,
    );
    expect(none!.n).toBe(0);

    // A wrong token is refused.
    const stale = await call(
      tenant.admin,
      "POST",
      `/api/imports/students/${uploaded.id}/columns/apply`,
      {
        ...target,
        preview_token: "0".repeat(64),
      },
    );
    expect(stale.status).toBe(409);
    expect((await json<{ code: string }>(stale)).code).toBe("IMPORT_COLUMN_PREVIEW_STALE");

    const applied = await call(
      tenant.admin,
      "POST",
      `/api/imports/students/${uploaded.id}/columns/apply`,
      {
        ...target,
        preview_token: preview.preview_token,
      },
    );
    expect(applied.status).toBe(200);
    expect(await json<{ written: number; field_created: boolean }>(applied)).toMatchObject({
      written: 3,
      field_created: false,
    });

    const answers = await asSchool(
      tenant.schoolId,
      (tx) =>
        tx<{ student_id: string; value: string }[]>`
        SELECT student_id, value #>> '{}' AS value FROM app.record_answers
        WHERE field_id = ${busStop}::uuid ORDER BY value
      `,
    );
    const importStudents = new Set(written.map((line) => line.studentId));
    expect(answers).toHaveLength(3);
    expect(answers.every((answer) => importStudents.has(answer.student_id))).toBe(true);
    expect(answers.some((answer) => answer.student_id === bystander.id)).toBe(false);

    // Audited per answer, as a record edit is, and once for the column.
    const [audits] = await asSchool(
      tenant.schoolId,
      (tx) =>
        tx<{ answers: number; columns: number }[]>`
        SELECT
          count(*) FILTER (WHERE target_table = 'record_answers')::int AS answers,
          count(*) FILTER (WHERE target_table = 'student_import_unmapped_columns')::int AS columns
        FROM app.audit_logs
      `,
    );
    expect(audits!.answers).toBe(3);
    expect(audits!.columns).toBe(1);

    const missingAfter = await json<{ total: number }>(
      await call(tenant.admin, "GET", "/api/records/missing/students?issue=missing"),
    );
    expect(missingAfter.total).toBe(missingBefore.total - 3);

    const columns = await json<ColumnsDto>(
      await call(tenant.admin, "GET", `/api/imports/students/${uploaded.id}/columns`),
    );
    expect(columns.columns.find((column) => column.position === 9)!.applied).toMatchObject({
      field_id: busStop,
      count: 3,
    });

    // Re-previewing now reports the values as already there; overwrite is off by default.
    const again = await json<PreviewDto>(
      await call(
        tenant.admin,
        "POST",
        `/api/imports/students/${uploaded.id}/columns/preview`,
        target,
      ),
    );
    expect(again.totals).toMatchObject({ write: 0, unchanged: 3 });
  });

  test("creates a sensitive field from a column, seals values and masks the preview", async () => {
    const tenant = await createTenant();
    const csv = csvFor(tenant.slug);
    const uploaded = await json<ImportDto>(
      await upload(tenant, csv, await stageSource(tenant.admin, csv)),
    );
    await confirmAndComplete(tenant, uploaded.id);

    const target = {
      position: 6,
      subject_kind: "student",
      new_field: {
        label_en: "Civil ID",
        label_ar: "الرقم المدني",
        field_type: "short_text",
        sensitivity: "sensitive",
      },
    };
    const previewResponse = await call(
      tenant.admin,
      "POST",
      `/api/imports/students/${uploaded.id}/columns/preview`,
      target,
    );
    const previewText = await previewResponse.text();
    expect(previewResponse.status).toBe(200);
    expect(previewText).not.toContain("289010112345");
    const preview = JSON.parse(previewText) as PreviewDto;
    expect(preview.rows.every((row) => row.value === null && row.mask !== null)).toBe(true);

    // A principal can write records but cannot run imports.
    const principal = await actor(tenant, "PRINCIPAL");
    expect(
      (
        await call(principal, "POST", `/api/imports/students/${uploaded.id}/columns/apply`, {
          ...target,
          preview_token: preview.preview_token,
        })
      ).status,
    ).toBe(403);

    const applied = await call(
      tenant.admin,
      "POST",
      `/api/imports/students/${uploaded.id}/columns/apply`,
      {
        ...target,
        preview_token: preview.preview_token,
      },
    );
    expect(applied.status).toBe(200);
    const result = await json<{ field_id: string; field_created: boolean; written: number }>(
      applied,
    );
    expect(result).toMatchObject({ field_created: true, written: 3 });

    const rows = await asSchool(
      tenant.schoolId,
      (tx) =>
        tx<
          {
            student_id: string;
            value: unknown;
            value_ciphertext: Uint8Array | null;
            value_key_id: string | null;
            value_mask: string | null;
          }[]
        >`
        SELECT student_id, value, value_ciphertext, value_key_id, value_mask
        FROM app.record_answers WHERE field_id = ${result.field_id}::uuid
      `,
    );
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.value === null && row.value_ciphertext !== null)).toBe(true);
    const opened = rows.map((row) =>
      openRecordValue(
        DEVELOPMENT_RECORD_KEYRING,
        {
          schoolId: tenant.schoolId,
          subjectKind: "student",
          subjectId: row.student_id,
          fieldId: result.field_id,
        },
        { ciphertext: row.value_ciphertext!, keyId: row.value_key_id!, mask: row.value_mask! },
      ).unwrap(),
    );
    expect(opened.sort()).toEqual(["289010112345", "290030398765", "301020254321"]);

    const audits = await asSchool(
      tenant.schoolId,
      (tx) =>
        tx<{ payload: string }[]>`
        SELECT coalesce(old_values::text, '') || coalesce(new_values::text, '') AS payload
        FROM app.audit_logs
      `,
    );
    for (const audit of audits) expect(audit.payload).not.toContain("289010112345");
  });

  test("refuses to publish a new field over other unpublished template changes", async () => {
    const tenant = await createTenant();
    const csv = csvFor(tenant.slug);
    const uploaded = await json<ImportDto>(
      await upload(tenant, csv, await stageSource(tenant.admin, csv)),
    );
    await confirmAndComplete(tenant, uploaded.id);
    await field(tenant, "student", { field_type: "short_text", label_en: "Draft only" });

    const target = {
      position: 9,
      subject_kind: "student",
      new_field: { label_en: "Bus stop", label_ar: "موقف", field_type: "short_text" },
    };
    const preview = await json<PreviewDto>(
      await call(
        tenant.admin,
        "POST",
        `/api/imports/students/${uploaded.id}/columns/preview`,
        target,
      ),
    );
    const applied = await call(
      tenant.admin,
      "POST",
      `/api/imports/students/${uploaded.id}/columns/apply`,
      {
        ...target,
        preview_token: preview.preview_token,
      },
    );
    expect(applied.status).toBe(409);
    expect((await json<{ code: string }>(applied)).code).toBe("IMPORT_RECORD_DRAFT_PENDING");
  });

  test("reports invalid cells by rule, keeps existing answers, and catches a change since preview", async () => {
    const tenant = await createTenant();
    const allergic = await field(tenant, "student", {
      field_type: "yes_no",
      label_en: "Allergy flag",
    });
    await publish(tenant, "student");
    const csv = csvFor(tenant.slug);
    const uploaded = await json<ImportDto>(
      await upload(tenant, csv, await stageSource(tenant.admin, csv)),
    );
    const written = await confirmAndComplete(tenant, uploaded.id);

    // S-2 already has an answer.
    const s2 = written.find((line) => line.line === 3)!.studentId;
    expect(
      (
        await call(tenant.admin, "PUT", `/api/students/${s2}/records`, {
          answers: [{ field_id: allergic, value: true }],
        })
      ).status,
    ).toBe(200);

    const target = { position: 8, subject_kind: "student", field_id: allergic };
    const preview = await json<PreviewDto>(
      await call(
        tenant.admin,
        "POST",
        `/api/imports/students/${uploaded.id}/columns/preview`,
        target,
      ),
    );
    expect(preview.totals).toMatchObject({ write: 2, kept: 1, invalid: 1 });
    const invalid = preview.rows.find((row) => row.status === "invalid")!;
    expect(invalid.reason).toBe("RECORD_VALUE_WRONG_TYPE");
    expect(invalid.value).toBeNull();

    // The answer changes between preview and apply: the confirm is refused.
    expect(
      (
        await call(tenant.admin, "PUT", `/api/students/${s2}/records`, {
          answers: [{ field_id: allergic, value: null }],
        })
      ).status,
    ).toBe(200);
    const stale = await call(
      tenant.admin,
      "POST",
      `/api/imports/students/${uploaded.id}/columns/apply`,
      {
        ...target,
        preview_token: preview.preview_token,
      },
    );
    expect(stale.status).toBe(409);
  });

  test("applies a parent column to the parents the import created; siblings must agree", async () => {
    const tenant = await createTenant();
    const employer = await field(tenant, "parent", {
      field_type: "short_text",
      label_en: "Employer",
    });
    await publish(tenant, "parent");
    const csv = [
      "Student ID,First,Last,Email,Guardian Email,Relationship,Employer",
      `S-1,Rana,Haddad,rana@${tenant.slug}.local,dad@${tenant.slug}.local,father,Acme`,
      `S-2,Omar,Haddad,omar@${tenant.slug}.local,dad@${tenant.slug}.local,father,Acme`,
      `S-3,Huda,Saleh,huda@${tenant.slug}.local,mum@${tenant.slug}.local,mother,Beta`,
      `S-4,Sami,Saleh,sami@${tenant.slug}.local,mum@${tenant.slug}.local,mother,Gamma`,
    ].join("\n");
    const uploaded = await json<ImportDto>(
      await upload(tenant, csv, await stageSource(tenant.admin, csv)),
    );
    await confirmAndComplete(tenant, uploaded.id);

    const columns = await json<ColumnsDto>(
      await call(tenant.admin, "GET", `/api/imports/students/${uploaded.id}/columns`),
    );
    expect(columns.columns[0]).toMatchObject({
      header: "Employer",
      parent_count: 2,
      student_count: 4,
    });

    const target = { position: 6, subject_kind: "parent", field_id: employer };
    const preview = await json<PreviewDto>(
      await call(
        tenant.admin,
        "POST",
        `/api/imports/students/${uploaded.id}/columns/preview`,
        target,
      ),
    );
    expect(preview.totals).toMatchObject({ write: 1, conflict: 1 });
    expect(preview.rows.find((row) => row.status === "conflict")!.reason).toBe(
      "CONFLICTING_VALUES",
    );
    const applied = await json<{ written: number }>(
      await call(tenant.admin, "POST", `/api/imports/students/${uploaded.id}/columns/apply`, {
        ...target,
        preview_token: preview.preview_token,
      }),
    );
    expect(applied.written).toBe(1);
  });
});

describeDb("platform unmapped header signal", () => {
  test("counts header text across schools, shows only headers three schools share", async () => {
    const operatorSchool = await createTenant();
    const operator = await actor(operatorSchool, "SUPER_ADMIN");
    const tag = crypto.randomUUID().slice(0, 6);
    for (let i = 0; i < 3; i++) {
      const tenant = await createTenant();
      const extra = i < 2 ? `,Favorite ${tag}` : "";
      const csv = [
        `Student ID,First,Last,Email,Blood ${tag}${extra}`,
        `S-1,A,B,a${i}@${tenant.slug}.local,O+${extra ? ",blue" : ""}`,
      ].join("\n");
      expect((await upload(tenant, csv)).status).toBe(201);
    }

    expect(
      (await call(operatorSchool.admin, "GET", "/api/platform/import-signals/unmapped-headers"))
        .status,
    ).toBe(403);
    const response = await call(operator, "GET", "/api/platform/import-signals/unmapped-headers");
    expect(response.status).toBe(200);
    const text = await response.text();
    const body = JSON.parse(text) as {
      min_schools: number;
      headers: { normalized_header: string; header: string; schools: number; imports: number }[];
    };
    expect(body.min_schools).toBe(3);
    expect(body.headers.find((h) => h.normalized_header === `blood${tag}`)).toMatchObject({
      header: `Blood ${tag}`,
      schools: 3,
      imports: 3,
    });
    expect(body.headers.some((h) => h.normalized_header === `favorite${tag}`)).toBe(false);
    expect(text).not.toContain("O+");
    expect(text).not.toContain("Test School");
  });
});
