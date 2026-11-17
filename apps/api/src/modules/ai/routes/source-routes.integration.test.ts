/**
 * A student's own AI sources (000232) over HTTP, on a live PostgreSQL with its real RLS:
 *
 *   - a student uploads a file or photo (presigned PUT, then confirm), and confirm reads the stored
 *     object back, meters it on the school's storage, and hands it to the malware scan;
 *   - the source is the owner's alone: another student, the class teacher, a parent and the school
 *     admin cannot read it or its text, and it never shows up as a class material -- even with the
 *     owner's id in the path (the student-self gate's job in production; RLS is the backstop);
 *   - the per-file, per-type and per-student limits refuse with their own codes;
 *   - a student's assignment becomes one shared source, staged for ingestion once and rebuilt when
 *     the assignment changes; an assignment they are not enrolled for, or of a class whose AI
 *     materials setting is off, cannot be used;
 *   - every tool's loader reads a ready personal source for its owner, and nobody else's.
 *
 *   TEST_DATABASE_URL=postgres://... bun test src/modules/ai/routes/source-routes.integration.test.ts
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES, ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import {
  createEnrollment,
  createFullTenant,
  createStudent,
  createTestDatabase,
  integrationEnabled,
  migrateDatabase,
  type TenantFixture,
  type TestDatabase,
} from "../../../../tests/harness";
import { withTenantTx } from "../../../db/tenant-tx";
import { errorHandlerMiddleware } from "../../../middleware/errorHandler";
import { openApiValidationHook } from "../../../openapi/hook";
import { listMaterials } from "../../academics/material-service";
import { AUTH_CHANNELS } from "../../auth/channels";
import {
  aiEntitlement,
  aiSubscriberFeatureService,
  fakeEntitlements,
  fakeFeatureService,
} from "../../features/__tests__/fakes";
import { loadQuizMaterials } from "../quiz/materials";
import { RETRIEVAL_EMBEDDING_MODEL } from "../retrieval/embeddings";
import { hybridSearch } from "../retrieval/search";
import { AI_SOURCE_MAX_PER_STUDENT } from "../sources/limits";
import { loadSummaryMaterial } from "../summary/materials";

import { aiSourceRoutes } from "./source-routes";

import type { StorageService } from "../../../lib/storage";
import type { Logger } from "../../../logger";
import type { AuthContext } from "../../../middleware/authContext";
import type { AppEnv } from "../../../middleware/requestId";
import type { FeatureService } from "../../features/service";
import type { Role } from "@studafy/constants";
import type { TransactionSql } from "postgres";

const describeDb = integrationEnabled ? describe : describe.skip;

const silentLogger: Logger = {
  level: "info",
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  child: () => silentLogger,
};

const PDF = "application/pdf";

function fakeStorage(): StorageService & { objects: Map<string, { size: number; type: string }> } {
  const objects = new Map<string, { size: number; type: string }>();
  return {
    objects,
    ttlSeconds: 900,
    check: async () => true,
    presign: (key, _method, _contentType, ttl) => ({
      url: `https://storage.example/${key}?signed`,
      expiresAt: new Date(Date.now() + (ttl ?? 900) * 1000),
    }),
    exists: async (key) => objects.has(key),
    size: async (key) => objects.get(key)?.size ?? 0,
    head: async (key) => {
      const object = objects.get(key);
      return object ? { contentType: object.type, sizeBytes: object.size } : null;
    },
    checksumSha256: async () => "a".repeat(64),
    copy: async () => undefined,
    remove: async (key) => {
      objects.delete(key);
    },
    async *list() {
      // Not used here.
    },
  };
}

interface Person {
  userId: string;
  roles: Role[];
  /** The student record, for a student. */
  studentId?: string;
}

let db: TestDatabase;
let adminClient: ReturnType<typeof postgres> | undefined;
let tenantClient: ReturnType<typeof postgres> | undefined;
let tenant: TenantFixture;
let studentA: Person;
let studentB: Person;
let outsider: Person;
let teacher: Person;
let parent: Person;
let admin: Person;
let otherClassId: string;
const storage = fakeStorage();
const scans: { materialId: string; storageKey: string }[] = [];
const ingestions: string[] = [];

async function asAdmin<T>(fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  let result: T | undefined;
  await adminClient!.begin(async (tx) => {
    await tx`SELECT set_config('app.school_id', ${tenant.schoolId}, true)`;
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    result = await fn(tx);
  });
  return result as T;
}

function asPerson<T>(person: Person, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return withTenantTx(tenantClient!, { schoolId: tenant.schoolId, userId: person.userId }, fn);
}

function buildApp(features: FeatureService = aiSubscriberFeatureService()) {
  const app = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
  app.use("*", async (c, next) => {
    const who = JSON.parse(c.req.header("x-test-person") ?? "{}") as Person;
    const auth: AuthContext = {
      userId: who.userId,
      schoolId: tenant.schoolId,
      roles: who.roles,
      channel: AUTH_CHANNELS.API,
      jti: "jti-sources",
      exp: Math.floor(Date.now() / 1000) + 900,
      entitlementsVer: 1,
      subscriptionStatus: "active",
    };
    c.set("auth", auth);
    c.set("locale", "en");
    c.set("features", features);
    await next();
  });
  app.route(
    "/",
    aiSourceRoutes({
      database: tenantClient!,
      storage,
      enqueueScan: async (data) => {
        scans.push({ materialId: data.materialId, storageKey: data.storageKey });
      },
      enqueueIngestion: async (_schoolId, materialId) => {
        ingestions.push(materialId);
      },
    }),
  );
  app.onError(errorHandlerMiddleware(silentLogger));
  return app;
}

let app: OpenAPIHono<AppEnv>;

function call(person: Person, method: string, path: string, body?: unknown, target = app) {
  return target.request(path, {
    method,
    headers: {
      "x-test-person": JSON.stringify(person),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const sourcesPath = (student: Person) => `/api/ai/students/${student.studentId}/sources`;

/** Upload and confirm one file as `student`; returns its source id and key. */
async function uploadSource(
  student: Person,
  options: { name?: string; type?: string; size?: number } = {},
): Promise<{ id: string; storageKey: string }> {
  const size = options.size ?? 2048;
  const type = options.type ?? PDF;
  const started = await call(student, "POST", `${sourcesPath(student)}/upload`, {
    original_file_name: options.name ?? "biology-notes.pdf",
    mime_type: type,
    size_bytes: size,
  });
  expect(started.status).toBe(201);
  const body = (await started.json()) as {
    source: { id: string };
    storage_key: string;
  };
  storage.objects.set(body.storage_key, { size, type });
  const confirmed = await call(
    student,
    "POST",
    `${sourcesPath(student)}/${body.source.id}/confirm`,
    {
      storage_key: body.storage_key,
    },
  );
  expect(confirmed.status).toBe(200);
  return { id: body.source.id, storageKey: body.storage_key };
}

/** Make a source ready with one chunk of text, as the ingestion worker would. */
async function makeReady(sourceId: string, content: string): Promise<void> {
  await asAdmin(async (tx) => {
    await tx`
      UPDATE app.materials
      SET ingest_status = 'ready', ingested_at = now(), updated_at = now()
      WHERE id = ${sourceId}::uuid
    `;
    await tx`
      INSERT INTO app.material_chunks
        (school_id, material_id, chunk_index, content, embedding, embedding_model)
      VALUES (
        ${tenant.schoolId}, ${sourceId}, 0, ${content},
        array_fill(0.01::real, ARRAY[1536])::public.vector, ${RETRIEVAL_EMBEDDING_MODEL}
      )
    `;
  });
}

async function insertAssignment(
  classId: string,
  options: { status?: "published" | "draft"; instructions?: string } = {},
): Promise<string> {
  const status = options.status ?? "published";
  return asAdmin(async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO app.assignments (
        school_id, class_id, created_by_user_id, last_edited_by_user_id, title, instructions,
        status, assigned_at, due_at, max_score
      ) VALUES (
        ${tenant.schoolId}, ${classId}, ${teacher.userId}, ${teacher.userId}, 'Cell biology essay',
        ${options.instructions ?? "Explain how mitochondria release energy."},
        ${status}::app.assignment_status, ${status === "draft" ? null : new Date()},
        now() + interval '7 days', 10
      )
      RETURNING id
    `;
    await tx`
      INSERT INTO app.assignment_attachments (
        school_id, assignment_id, uploaded_by_user_id, storage_key, original_file_name, mime_type,
        size_bytes, scan_status
      ) VALUES (
        ${tenant.schoolId}, ${row!.id}, ${teacher.userId},
        ${`permanent/${tenant.schoolId}/assignments/${crypto.randomUUID()}-worksheet.pdf`},
        'worksheet.pdf', 'application/pdf', 4096, 'clean'
      )
    `;
    return row!.id;
  });
}

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createTestDatabase();
  await migrateDatabase(db.url);
  // Pinned single connections, as retrieval-routes.integration.test.ts explains.
  adminClient = postgres(db.url, { max: 1, prepare: false });
  tenantClient = postgres(db.url, { max: 1, prepare: false });

  tenant = await createFullTenant(db.sql);
  const primary = tenant.students[0]!;
  studentA = { userId: primary.userId, roles: [ROLES.STUDENT], studentId: primary.id };
  const classmate = await createStudent(db.sql, tenant.schoolId);
  await createEnrollment(db.sql, tenant.schoolId, tenant.cls.id, classmate.id);
  studentB = { userId: classmate.userId, roles: [ROLES.STUDENT], studentId: classmate.id };
  // Enrolled nowhere this suite's assignments are.
  const loner = await createStudent(db.sql, tenant.schoolId);
  outsider = { userId: loner.userId, roles: [ROLES.STUDENT], studentId: loner.id };
  teacher = { userId: tenant.teachers[0]!.userId, roles: [ROLES.INSTRUCTOR] };
  admin = { userId: tenant.users.ORG_ADMIN.id, roles: [ROLES.ORG_ADMIN] };
  parent = { userId: tenant.users.PARENT.id, roles: [ROLES.PARENT] };

  await asAdmin(async (tx) => {
    await tx`
      INSERT INTO app.user_roles (school_id, user_id, role)
      VALUES (${tenant.schoolId}, ${teacher.userId}, 'INSTRUCTOR')
      ON CONFLICT DO NOTHING
    `;
    const [family] = await tx<{ id: string }[]>`
      INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
      VALUES (${tenant.schoolId}, 'Family A', ${parent.userId}) RETURNING id
    `;
    await tx`
      INSERT INTO app.parent_child_links
        (school_id, parent_user_id, student_id, relationship, family_id)
      VALUES (${tenant.schoolId}, ${parent.userId}, ${studentA.studentId!}, 'guardian', ${family!.id})
    `;
    // A second class of the same course with AI materials off, where only the outsider is enrolled.
    const [other] = await tx<{ id: string }[]>`
      INSERT INTO app.classes (
        school_id, course_id, academic_year_id, term_id, lead_teacher_id, room_id, code, status,
        ai_materials_enabled
      )
      SELECT school_id, course_id, academic_year_id, term_id, lead_teacher_id, room_id,
             code || '-B', status, false
      FROM app.classes WHERE id = ${tenant.cls.id}
      RETURNING id
    `;
    otherClassId = other!.id;
  });
  await createEnrollment(db.sql, tenant.schoolId, otherClassId, outsider.studentId!);

  app = buildApp();
}, 60_000);

afterAll(async () => {
  await adminClient?.end();
  await tenantClient?.end();
  await db?.cleanup();
});

describeDb("own files and photos", () => {
  test("upload -> confirm meters the stored size and sends the file to the malware scan", async () => {
    const meterBefore = await asAdmin(
      (tx) => tx<{ bytes: string | null }[]>`
        SELECT bytes_used::text AS bytes FROM app.storage_usage_meters
        WHERE school_id = ${tenant.schoolId}::uuid
      `,
    );
    const { id, storageKey } = await uploadSource(studentA, {
      name: "page.jpg",
      type: "image/jpeg",
    });

    expect(storageKey.startsWith(`permanent/${tenant.schoolId}/ai-sources/`)).toBe(true);
    expect(scans).toContainEqual({ materialId: id, storageKey });

    const listed = await call(studentA, "GET", sourcesPath(studentA));
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as {
      sources: { id: string; kind: string; status: string; title: string }[];
      usage: { count: number };
    };
    const source = body.sources.find((row) => row.id === id);
    expect(source).toMatchObject({ kind: "personal", status: "scanning", title: "page" });
    expect(body.usage.count).toBeGreaterThanOrEqual(1);

    const meterAfter = await asAdmin(
      (tx) => tx<{ bytes: string }[]>`
        SELECT bytes_used::text AS bytes FROM app.storage_usage_meters
        WHERE school_id = ${tenant.schoolId}::uuid
      `,
    );
    expect(Number(meterAfter[0]!.bytes) - Number(meterBefore[0]?.bytes ?? 0)).toBe(2048);
  });

  test("a personal source is its owner's alone, at the API and in the database", async () => {
    const { id } = await uploadSource(studentA, { name: "secret-notes.pdf" });
    await makeReady(id, "Mitochondria are the powerhouse of the cell, my private notes say.");

    // Another student: not listed, not readable, not deletable -- even naming the owner's id.
    const theirList = (await (await call(studentB, "GET", sourcesPath(studentB))).json()) as {
      sources: { id: string }[];
    };
    expect(theirList.sources.map((row) => row.id)).not.toContain(id);
    expect((await call(studentB, "GET", `${sourcesPath(studentB)}/${id}`)).status).toBe(404);
    expect((await call(studentB, "GET", `${sourcesPath(studentA)}/${id}`)).status).toBe(404);
    expect((await call(studentB, "DELETE", `${sourcesPath(studentA)}/${id}`)).status).toBe(404);

    // Raw reads under each role's row scope: the material row and its text.
    for (const person of [studentB, teacher, parent, admin]) {
      const rows = await asPerson(
        person,
        (tx) => tx`
        SELECT id FROM app.materials WHERE id = ${id}::uuid
      `,
      );
      const chunks = await asPerson(
        person,
        (tx) => tx`
        SELECT id FROM app.material_chunks WHERE material_id = ${id}::uuid
      `,
      );
      expect({ person: person.roles[0], rows: rows.length, chunks: chunks.length }).toEqual({
        person: person.roles[0],
        rows: 0,
        chunks: 0,
      });
    }
    const own = await asPerson(
      studentA,
      (tx) => tx`
      SELECT c.id FROM app.material_chunks AS c WHERE c.material_id = ${id}::uuid
    `,
    );
    expect(own).toHaveLength(1);

    // The AI tools' loaders: the owner reads it, nobody else does.
    const mine = await asPerson(studentA, (tx) => loadSummaryMaterial(tx, id));
    expect(mine.status).toBe("ok");
    const theirs = await asPerson(studentB, (tx) => loadSummaryMaterial(tx, id));
    expect(theirs.status).toBe("not_found");
    const quiz = await asPerson(studentB, (tx) => loadQuizMaterials(tx, [id]));
    expect(quiz.status).toBe("not_found");

    // Retrieval: only when the source is the one asked about, and only for its owner.
    const scoped = await asPerson(studentA, (tx) =>
      hybridSearch(tx, { query: "mitochondria powerhouse", queryVector: null, materialId: id }),
    );
    expect(scoped.hits.map((hit) => hit.materialId)).toEqual([id]);
    const everything = await asPerson(studentA, (tx) =>
      hybridSearch(tx, { query: "mitochondria powerhouse", queryVector: null }),
    );
    expect(everything.hits.map((hit) => hit.materialId)).not.toContain(id);
    const othersScoped = await asPerson(studentB, (tx) =>
      hybridSearch(tx, { query: "mitochondria powerhouse", queryVector: null, materialId: id }),
    );
    expect(othersScoped.hits).toHaveLength(0);

    // Never a class material, not even for its owner.
    const classList = await asPerson(studentA, (tx) =>
      listMaterials(tx, tenant.schoolId, { limit: 100, offset: 0 }),
    );
    expect(classList.rows.map((row) => row.id)).not.toContain(id);
  });

  test("the owner deletes a source; its file is removed", async () => {
    const { id, storageKey } = await uploadSource(studentA, { name: "old.pdf" });
    expect(storage.objects.has(storageKey)).toBe(true);
    const deleted = await call(studentA, "DELETE", `${sourcesPath(studentA)}/${id}`);
    expect(deleted.status).toBe(204);
    expect(storage.objects.has(storageKey)).toBe(false);
    expect((await call(studentA, "GET", `${sourcesPath(studentA)}/${id}`)).status).toBe(404);
  });

  test("type, size and per-student limits refuse with their own codes", async () => {
    const unsupported = await call(studentB, "POST", `${sourcesPath(studentB)}/upload`, {
      original_file_name: "song.mp3",
      mime_type: "audio/mpeg",
      size_bytes: 100,
    });
    expect(unsupported.status).toBe(422);
    expect(((await unsupported.json()) as { code: string }).code).toBe(
      ERROR_CODES.AI_SOURCE_UNSUPPORTED_TYPE,
    );

    const huge = await call(studentB, "POST", `${sourcesPath(studentB)}/upload`, {
      original_file_name: "huge.pdf",
      mime_type: PDF,
      size_bytes: 500 * 1024 * 1024,
    });
    expect(huge.status).toBe(422);
    expect(((await huge.json()) as { code: string }).code).toBe(ERROR_CODES.AI_SOURCE_TOO_LARGE);

    // The stored object decides at confirm, not the claim made at upload.
    const started = await call(studentB, "POST", `${sourcesPath(studentB)}/upload`, {
      original_file_name: "liar.pdf",
      mime_type: PDF,
      size_bytes: 10,
    });
    const startedBody = (await started.json()) as { source: { id: string }; storage_key: string };
    storage.objects.set(startedBody.storage_key, { size: 400 * 1024 * 1024, type: PDF });
    const lied = await call(
      studentB,
      "POST",
      `${sourcesPath(studentB)}/${startedBody.source.id}/confirm`,
      { storage_key: startedBody.storage_key },
    );
    expect(lied.status).toBe(422);
    expect(((await lied.json()) as { code: string }).code).toBe(ERROR_CODES.AI_SOURCE_TOO_LARGE);

    // Fill the student's allowance, then one more is refused.
    for (let index = 0; index < AI_SOURCE_MAX_PER_STUDENT; index += 1) {
      const response = await call(studentB, "POST", `${sourcesPath(studentB)}/upload`, {
        original_file_name: `notes-${index}.pdf`,
        mime_type: PDF,
        size_bytes: 10,
      });
      if (response.status !== 201) {
        expect(((await response.json()) as { code: string }).code).toBe(
          ERROR_CODES.AI_SOURCE_LIMIT_REACHED,
        );
        return;
      }
    }
    const over = await call(studentB, "POST", `${sourcesPath(studentB)}/upload`, {
      original_file_name: "one-too-many.pdf",
      mime_type: PDF,
      size_bytes: 10,
    });
    expect(over.status).toBe(422);
    expect(((await over.json()) as { code: string }).code).toBe(
      ERROR_CODES.AI_SOURCE_LIMIT_REACHED,
    );
  });

  test("a student without any AI feature is refused", async () => {
    const noAi = buildApp(fakeFeatureService({ entitlements: fakeEntitlements({}) }));
    const response = await call(studentA, "GET", sourcesPath(studentA), undefined, noAi);
    expect(response.status).toBe(402);
    const withAi = buildApp(
      fakeFeatureService({ entitlements: fakeEntitlements({ ai: aiEntitlement("active") }) }),
    );
    expect((await call(studentA, "GET", sourcesPath(studentA), undefined, withAi)).status).toBe(
      200,
    );
  });
});

describeDb("assignments as sources", () => {
  const assignmentPath = (student: Person, assignmentId?: string) =>
    `/api/ai/students/${student.studentId}/assignment-sources${assignmentId ? `/${assignmentId}` : ""}`;

  test("lists the student's published assignments, and builds one shared source", async () => {
    const assignmentId = await insertAssignment(tenant.cls.id);
    const draftId = await insertAssignment(tenant.cls.id, { status: "draft" });

    const listed = (await (await call(studentA, "GET", assignmentPath(studentA))).json()) as {
      assignments: { assignment_id: string; attachment_count: number; source_id: string | null }[];
    };
    const row = listed.assignments.find((item) => item.assignment_id === assignmentId);
    expect(row).toMatchObject({ attachment_count: 1, source_id: null });
    expect(listed.assignments.map((item) => item.assignment_id)).not.toContain(draftId);

    ingestions.length = 0;
    const first = await call(studentA, "POST", assignmentPath(studentA, assignmentId));
    expect(first.status).toBe(200);
    const source = (await first.json()) as { id: string; kind: string; status: string };
    expect(source).toMatchObject({ kind: "assignment", status: "queued" });
    expect(ingestions).toEqual([source.id]);

    // A classmate gets the same source, with no second build.
    const second = await call(studentB, "POST", assignmentPath(studentB, assignmentId));
    expect(((await second.json()) as { id: string }).id).toBe(source.id);
    expect(ingestions).toEqual([source.id]);

    // The class's teacher and a parent of an enrolled child see it as they see the assignment.
    for (const person of [teacher, parent]) {
      const rows = await asPerson(
        person,
        (tx) => tx`
        SELECT id FROM app.materials WHERE id = ${source.id}::uuid
      `,
      );
      expect(rows).toHaveLength(1);
    }
    // ...but it is never a class material.
    const classList = await asPerson(teacher, (tx) =>
      listMaterials(tx, tenant.schoolId, { limit: 100, offset: 0, class_id: tenant.cls.id }),
    );
    expect(classList.rows.map((item) => item.id)).not.toContain(source.id);

    // Ready and unchanged: nothing to rebuild.
    await makeReady(source.id, "Explain how mitochondria release energy.");
    await call(studentA, "POST", assignmentPath(studentA, assignmentId));
    expect(ingestions).toEqual([source.id]);

    // The teacher edits the instructions: the next request rebuilds it.
    await asAdmin(
      (tx) => tx`
      UPDATE app.assignments SET instructions = 'Now compare mitochondria and chloroplasts.'
      WHERE id = ${assignmentId}::uuid
    `,
    );
    const rebuilt = (await (
      await call(studentA, "POST", assignmentPath(studentA, assignmentId))
    ).json()) as { id: string; status: string };
    expect(rebuilt).toMatchObject({ id: source.id, status: "queued" });
    expect(ingestions).toEqual([source.id, source.id]);
  });

  test("an assignment the student is not enrolled for, or a draft, is not found", async () => {
    const assignmentId = await insertAssignment(tenant.cls.id);
    const draftId = await insertAssignment(tenant.cls.id, { status: "draft" });
    expect((await call(outsider, "POST", assignmentPath(outsider, assignmentId))).status).toBe(404);
    expect((await call(studentA, "POST", assignmentPath(studentA, draftId))).status).toBe(404);
  });

  test("a class with its AI materials setting off cannot be used", async () => {
    const assignmentId = await insertAssignment(otherClassId);
    const response = await call(outsider, "POST", assignmentPath(outsider, assignmentId));
    expect(response.status).toBe(422);
    expect(((await response.json()) as { code: string }).code).toBe(
      ERROR_CODES.AI_SOURCE_AI_DISABLED,
    );
  });

  test("deleting the assignment deletes its source", async () => {
    const assignmentId = await insertAssignment(tenant.cls.id);
    const source = (await (
      await call(studentA, "POST", assignmentPath(studentA, assignmentId))
    ).json()) as { id: string };
    await asAdmin((tx) => tx`DELETE FROM app.assignments WHERE id = ${assignmentId}::uuid`);
    const left = await asAdmin(
      (tx) => tx`SELECT id FROM app.materials WHERE id = ${source.id}::uuid`,
    );
    expect(left).toHaveLength(0);
  });
});
