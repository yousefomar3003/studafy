/**
 * The per-class "Use this class's materials with the AI study assistant" setting (000196).
 *
 * Full HTTP path for the route (real JWTs, the material:manageAi gate, a tenant transaction with
 * RLS armed), plus the AI read paths straight against PostgreSQL:
 *
 *   - who may change it: the class's teacher, the principal and the school admin; not a student or
 *     guest (permission gate), and not a teacher of another class;
 *   - turning it off deletes the class's chunks (and nothing of another class), and is audited;
 *   - while it is off, hybrid retrieval and every generation loader (explain, summary, quiz, exam)
 *     refuse the class's materials, even for a chunk that reappears behind the purge;
 *   - turning it on re-stages the class's AI-visible `ready` materials to `queued`; a per-material
 *     re-enable inside a class with the setting off does not.
 *
 * Set TEST_DATABASE_URL to run these:
 *   TEST_DATABASE_URL=postgres://... bun test src/modules/academics/__tests__/class-ai-materials.integration.test.ts
 */

import { ERROR_CODES, ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  assignRole,
  authenticatedRequest,
  createClass,
  createFullTenant,
  createMaterial,
  createTeacher,
  createTestApp,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
} from "../../../../tests/harness";
import { withTenantTx } from "../../../db/tenant-tx";
import { validateExamMaterials } from "../../ai/exam/materials";
import { loadExplainPassage } from "../../ai/explain/materials";
import { loadQuizMaterials } from "../../ai/quiz/materials";
import { hybridSearch } from "../../ai/retrieval/search";
import { loadSummaryMaterial } from "../../ai/summary/materials";
import { toggleAiVisible } from "../material-service";

import type { TestApp, TestDatabase } from "../../../../tests/harness";
import type { Role } from "@studafy/constants";
import type { TransactionSql } from "postgres";

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
}, 60_000);

afterAll(async () => {
  harness?.keyStore.destroy();
  await database?.cleanup();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Actor {
  schoolId: string;
  userId: string;
  roles: Role[];
}

interface World {
  schoolId: string;
  classId: string;
  otherClassId: string;
  teacher: Actor;
  otherTeacher: Actor;
  principal: Actor;
  admin: Actor;
  student: Actor;
  guest: Actor;
}

const KEYWORD = "photosynthesis";
const DIMENSIONS = 1536;

function embedding(seed: number): string {
  const parts = Array.from({ length: DIMENSIONS }, (_, index) =>
    Math.sin(seed * 0.017 + index * 0.013).toFixed(6),
  );
  return `[${parts.join(",")}]`;
}

async function asAdmin<T>(schoolId: string, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  let result: T | undefined;
  await database!.sql.begin(async (tx) => {
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    result = await fn(tx);
  });
  return result as T;
}

async function buildWorld(): Promise<World> {
  const sql = database!.sql;
  const fixture = await createFullTenant(sql);
  const schoolId = fixture.schoolId;

  // The fixture's lead teacher has a profile but no role; acting as a teacher needs INSTRUCTOR.
  const teacher = fixture.teachers[0]!;
  await assignRole(sql, schoolId, teacher.userId, ROLES.INSTRUCTOR);

  // A second teacher who leads a different class: holds material:manageAi, teaches nothing here.
  const other = await createTeacher(sql, schoolId, {
    email: `other-teacher-${crypto.randomUUID().slice(0, 8)}@test.local`,
  });
  await assignRole(sql, schoolId, other.userId, ROLES.INSTRUCTOR);
  const otherClass = await createClass(sql, schoolId, {
    courseId: fixture.course.id,
    academicYearId: fixture.academicYear.id,
    termId: fixture.term.id,
    leadTeacherId: other.id,
    roomId: fixture.room.id,
  });

  const principalUser = await createUser(sql, schoolId, {
    email: `principal-${crypto.randomUUID().slice(0, 8)}@test.local`,
  });
  await assignRole(sql, schoolId, principalUser.id, ROLES.PRINCIPAL);

  return {
    schoolId,
    classId: fixture.cls.id,
    otherClassId: otherClass.id,
    teacher: { schoolId, userId: teacher.userId, roles: [ROLES.INSTRUCTOR] },
    otherTeacher: { schoolId, userId: other.userId, roles: [ROLES.INSTRUCTOR] },
    principal: { schoolId, userId: principalUser.id, roles: [ROLES.PRINCIPAL] },
    admin: { schoolId, userId: fixture.users.ORG_ADMIN.id, roles: [ROLES.ORG_ADMIN] },
    // The enrolled student (the fixture's role-loop STUDENT user is enrolled in nothing).
    student: { schoolId, userId: fixture.students[0]!.userId, roles: [ROLES.STUDENT] },
    guest: { schoolId, userId: fixture.users.GUEST.id, roles: [ROLES.GUEST] },
  };
}

/** An AI-visible material in `classId`, forced to `ready` (or `aiVisible: false`), with chunks. */
async function seedIngestedMaterial(
  world: World,
  classId: string,
  uploader: Actor,
  options: { chunks?: number; aiVisible?: boolean } = {},
): Promise<string> {
  const material = await createMaterial(database!.sql, world.schoolId, {
    classId,
    uploadedByUserId: uploader.userId,
  });
  await asAdmin(world.schoolId, async (tx) => {
    await tx`
      UPDATE app.materials
      SET ai_visible = ${options.aiVisible ?? true},
          ingest_status = 'ready'::app.material_ingest_status,
          ingested_at = CURRENT_TIMESTAMP
      WHERE id = ${material.id}
    `;
  });
  for (let index = 0; index < (options.chunks ?? 2); index += 1) {
    await insertChunk(world.schoolId, material.id, index);
  }
  return material.id;
}

async function insertChunk(schoolId: string, materialId: string, index: number): Promise<string> {
  return asAdmin(schoolId, async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO app.material_chunks
        (school_id, material_id, chunk_index, content, embedding, embedding_model)
      VALUES (
        ${schoolId}, ${materialId}, ${index},
        ${`Chapter ${index}: ${KEYWORD} turns light into chemical energy.`},
        ${embedding(index + 1)}::public.vector, 'mock-embedding-3-small@1'
      )
      RETURNING id
    `;
    return row!.id;
  });
}

async function chunkCount(schoolId: string, materialIds: string[]): Promise<number> {
  const [row] = await asAdmin(
    schoolId,
    (tx) => tx<{ count: number }[]>`
    SELECT count(*)::int AS count FROM app.material_chunks
    WHERE material_id = ANY (${materialIds}::uuid[])
  `,
  );
  return row!.count;
}

async function materialState(
  schoolId: string,
  materialId: string,
): Promise<{ ingest_status: string; ingested_at: Date | null; ai_visible: boolean }> {
  const [row] = await asAdmin(
    schoolId,
    (tx) => tx<{ ingest_status: string; ingested_at: Date | null; ai_visible: boolean }[]>`
    SELECT ingest_status::text AS ingest_status, ingested_at, ai_visible
    FROM app.materials WHERE id = ${materialId}
  `,
  );
  return row!;
}

function request(actor: Actor, method: string, path: string, body?: unknown) {
  return authenticatedRequest(
    harness!,
    method,
    path,
    { channel: "web", ...actor },
    body === undefined
      ? undefined
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
}

const settingPath = (classId: string) => `/api/academics/classes/${classId}/ai-materials`;

function setSetting(actor: Actor, classId: string, enabled: boolean) {
  return request(actor, "PUT", settingPath(classId), { enabled });
}

/** Run `fn` the way a request does: a tenant transaction as `actor`, RLS armed. */
function asTenant<T>(actor: Actor, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return withTenantTx(database!.sql, { schoolId: actor.schoolId, userId: actor.userId }, fn);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeDb("class AI materials setting — permissions", () => {
  test("defaults to on and is readable by the class's teacher and students", async () => {
    const world = await buildWorld();

    for (const actor of [world.teacher, world.student]) {
      const res = await request(actor, "GET", settingPath(world.classId));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ class_id: world.classId, enabled: true });
    }
  });

  test("a student and a guest are refused by the material:manageAi gate", async () => {
    const world = await buildWorld();

    for (const actor of [world.student, world.guest]) {
      const res = await setSetting(actor, world.classId, false);
      expect(res.status).toBe(403);
    }
    const res = await request(world.teacher, "GET", settingPath(world.classId));
    expect(((await res.json()) as { enabled: boolean }).enabled).toBe(true);
  });

  test("a teacher of another class cannot change it", async () => {
    const world = await buildWorld();

    const res = await setSetting(world.otherTeacher, world.classId, false);
    // RLS hides a class the teacher neither teaches nor is enrolled in: it reads as absent.
    expect(res.status).toBe(404);

    const after = await request(world.teacher, "GET", settingPath(world.classId));
    expect(((await after.json()) as { enabled: boolean }).enabled).toBe(true);
  });

  test("a staff member who can see the class but does not teach it gets the coded 403", async () => {
    const world = await buildWorld();
    // A teacher who also runs the attendance office: that role makes every class readable (RLS),
    // INSTRUCTOR passes the permission gate, but they do not teach this class -- the service's own
    // check is what refuses them.
    const sql = database!.sql;
    const dualUser = await createUser(sql, world.schoolId, {
      email: `dual-${crypto.randomUUID().slice(0, 8)}@test.local`,
    });
    await assignRole(sql, world.schoolId, dualUser.id, ROLES.INSTRUCTOR);
    await assignRole(sql, world.schoolId, dualUser.id, ROLES.ATTENDANCE_OFFICER);
    const dual: Actor = {
      schoolId: world.schoolId,
      userId: dualUser.id,
      roles: [ROLES.INSTRUCTOR, ROLES.ATTENDANCE_OFFICER],
    };

    expect((await request(dual, "GET", settingPath(world.classId))).status).toBe(200);
    const res = await setSetting(dual, world.classId, false);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe(
      ERROR_CODES.CLASS_AI_MATERIALS_FORBIDDEN,
    );
  });

  test("the class's teacher, the principal and the school admin can change it", async () => {
    const world = await buildWorld();

    let res = await setSetting(world.teacher, world.classId, false);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ class_id: world.classId, enabled: false });

    res = await setSetting(world.principal, world.classId, true);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ class_id: world.classId, enabled: true });

    res = await setSetting(world.admin, world.classId, false);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ class_id: world.classId, enabled: false });
  });

  test("an unknown class is 404 and a malformed body is 400", async () => {
    const world = await buildWorld();

    const missing = await setSetting(world.admin, crypto.randomUUID(), false);
    expect(missing.status).toBe(404);

    const malformed = await request(world.admin, "PUT", settingPath(world.classId), {
      enabled: "no",
    });
    expect(malformed.status).toBe(400);
  });
});

describeDb("class AI materials setting — turning it off", () => {
  test("deletes the class's chunks, keeps another class's, and audits the change", async () => {
    const world = await buildWorld();
    const first = await seedIngestedMaterial(world, world.classId, world.teacher, { chunks: 3 });
    const second = await seedIngestedMaterial(world, world.classId, world.teacher, { chunks: 2 });
    const elsewhere = await seedIngestedMaterial(world, world.otherClassId, world.otherTeacher);
    expect(await chunkCount(world.schoolId, [first, second])).toBe(5);

    const res = await setSetting(world.teacher, world.classId, false);
    expect(res.status).toBe(200);

    expect(await chunkCount(world.schoolId, [first, second])).toBe(0);
    expect(await chunkCount(world.schoolId, [elsewhere])).toBe(2);
    // The materials themselves stay downloadable.
    expect((await materialState(world.schoolId, first)).ingest_status).toBe("ready");

    const audits = await asAdmin(
      world.schoolId,
      (tx) => tx<{ actor_id: string; old_values: unknown; new_values: unknown }[]>`
      SELECT actor_id, old_values, new_values FROM app.audit_logs
      WHERE target_table = 'classes' AND target_id = ${world.classId}
        AND new_values ? 'ai_materials_enabled'
    `,
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actor_id).toBe(world.teacher.userId);
    expect(audits[0]!.old_values).toEqual({ ai_materials_enabled: true });
    expect(audits[0]!.new_values).toEqual({ ai_materials_enabled: false, chunks_purged: 5 });

    // Repeating the current value changes nothing and writes no second audit row.
    const again = await setSetting(world.teacher, world.classId, false);
    expect(again.status).toBe(200);
    const [count] = await asAdmin(
      world.schoolId,
      (tx) => tx<{ count: number }[]>`
      SELECT count(*)::int AS count FROM app.audit_logs
      WHERE target_table = 'classes' AND target_id = ${world.classId}
        AND new_values ? 'ai_materials_enabled'
    `,
    );
    expect(count!.count).toBe(1);
  });

  test("retrieval and every generation loader exclude the class's materials", async () => {
    const world = await buildWorld();
    const materialId = await seedIngestedMaterial(world, world.classId, world.teacher);

    // Before: the student retrieves the class's chunks and every loader accepts the material.
    const before = await asTenant(world.student, (tx) =>
      hybridSearch(tx, { query: KEYWORD, queryVector: null }),
    );
    expect(before.hits.map((hit) => hit.materialId)).toContain(materialId);
    expect(
      (await asTenant(world.student, (tx) => loadSummaryMaterial(tx, materialId))).status,
    ).toBe("ok");

    expect((await setSetting(world.teacher, world.classId, false)).status).toBe(200);

    // A chunk that reappears behind the purge (a race the worker's re-claim missed) must still
    // never ground an answer: the read paths check the setting themselves.
    const strayChunkId = await insertChunk(world.schoolId, materialId, 9);

    const after = await asTenant(world.student, (tx) =>
      hybridSearch(tx, { query: KEYWORD, queryVector: null }),
    );
    expect(after.hits.map((hit) => hit.materialId)).not.toContain(materialId);

    const scoped = await asTenant(world.student, (tx) =>
      hybridSearch(tx, { query: KEYWORD, queryVector: embedding(10), materialId }),
    );
    expect(scoped.hits).toHaveLength(0);

    expect(
      (await asTenant(world.student, (tx) => loadExplainPassage(tx, strayChunkId))).status,
    ).toBe("not_ready");
    expect(
      (await asTenant(world.student, (tx) => loadSummaryMaterial(tx, materialId))).status,
    ).toBe("not_ready");
    expect(
      (await asTenant(world.student, (tx) => loadQuizMaterials(tx, [materialId]))).status,
    ).toBe("not_ready");
    expect(
      (await asTenant(world.student, (tx) => validateExamMaterials(tx, [materialId]))).status,
    ).toBe("not_ready");
  });
});

describeDb("class AI materials setting — turning it back on", () => {
  test("re-stages the class's AI-visible ready materials for ingestion", async () => {
    const world = await buildWorld();
    const aiMaterial = await seedIngestedMaterial(world, world.classId, world.teacher);
    const hidden = await seedIngestedMaterial(world, world.classId, world.teacher, {
      aiVisible: false,
      chunks: 0,
    });
    const elsewhere = await seedIngestedMaterial(world, world.otherClassId, world.otherTeacher);

    expect((await setSetting(world.teacher, world.classId, false)).status).toBe(200);
    expect((await materialState(world.schoolId, aiMaterial)).ingest_status).toBe("ready");

    const res = await setSetting(world.teacher, world.classId, true);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ class_id: world.classId, enabled: true });

    const restaged = await materialState(world.schoolId, aiMaterial);
    expect(restaged.ingest_status).toBe("queued");
    expect(restaged.ingested_at).toBeNull();
    // Not AI-visible: stays as it was. Another class: untouched.
    expect((await materialState(world.schoolId, hidden)).ingest_status).toBe("ready");
    expect((await materialState(world.schoolId, elsewhere)).ingest_status).toBe("ready");
  });

  test("re-enabling one material's AI visibility while the class setting is off does not re-stage it", async () => {
    const world = await buildWorld();
    const materialId = await seedIngestedMaterial(world, world.classId, world.teacher, {
      aiVisible: false,
      chunks: 0,
    });
    expect((await setSetting(world.teacher, world.classId, false)).status).toBe(200);

    const row = await asTenant(world.teacher, (tx) =>
      toggleAiVisible(tx, world.schoolId, materialId, true),
    );
    expect(row.ai_visible).toBe(true);
    expect(row.ingest_status).toBe("ready");

    // Turning the class setting on then picks it up.
    expect((await setSetting(world.teacher, world.classId, true)).status).toBe(200);
    expect((await materialState(world.schoolId, materialId)).ingest_status).toBe("queued");
  });
});
