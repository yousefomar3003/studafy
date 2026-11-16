/**
 * Who may write a class's materials, over HTTP.
 *
 * Reading a class's materials is open to everyone who can read the class (RLS
 * role_scope_visibility: its teachers, its enrolled students, their parents, school leadership).
 * Writing them is not: upload, confirm, edit, AI visibility, retry and delete need the matching
 * material permission (teachers and the school admin hold them; students and parents do not), and
 * a teacher may then write only to a class they teach. The school admin may write to any class.
 *
 * A teacher of another class cannot see this class's materials at all, so a write by material id
 * answers 404 for them (the row is invisible, and saying 403 would confirm it exists). The 403 for
 * "staff, but not your class" shows up where the teacher can see the class without teaching it:
 * a teacher whose own child is enrolled there.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/academics/material-write-authz-http.test.ts
 */

import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  assignRole,
  authenticatedRequest,
  createClass,
  createFullTenant,
  createTeacher,
  createTestApp,
  createTestDatabase,
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import type { StorageService } from "../../src/lib/storage";
import type { TestApp, TestDatabase, TenantFixture } from "../harness";
import type { Role } from "@studafy/constants";

const describeDb = integrationEnabled ? describe : describe.skip;

function fakeStorage(): StorageService & { objects: Map<string, number> } {
  const objects = new Map<string, number>();
  return {
    objects,
    ttlSeconds: 900,
    check: async () => true,
    presign: (key, _method, _contentType, ttl) => ({
      url: `https://storage.example/${key}?signed`,
      expiresAt: new Date(Date.now() + (ttl ?? 900) * 1000),
    }),
    exists: async (key) => objects.has(key),
    size: async (key) => objects.get(key) ?? 0,
    head: async (key) => {
      const sizeBytes = objects.get(key);
      return sizeBytes === undefined ? null : { contentType: "application/pdf", sizeBytes };
    },
    checksumSha256: async () => "a".repeat(64),
    copy: async (source, destination) => {
      const sizeBytes = objects.get(source);
      if (sizeBytes !== undefined) objects.set(destination, sizeBytes);
    },
    remove: async (key) => {
      objects.delete(key);
    },
    async *list(prefix) {
      for (const [key, sizeBytes] of objects) {
        if (key.startsWith(prefix)) yield { key, sizeBytes };
      }
    },
  };
}

let database: TestDatabase | undefined;
let harness: TestApp | undefined;
const storage = fakeStorage();

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  const created = createTestApp({
    database: database.sql,
    storage,
    uploadScanEnqueuer: async () => undefined,
  });
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
  userId: string;
  roles: Role[];
}

interface World {
  tenant: TenantFixture;
  /** Leads the class. */
  teacher: Actor;
  admin: Actor;
  /** Enrolled in the class. */
  student: Actor;
  /** The student's parent. */
  parent: Actor;
  /** Leads a different class of the same school; cannot see this class at all. */
  otherTeacher: Actor;
  /** Teaches another class, and is also the parent of the enrolled student: sees, never teaches. */
  teacherParent: Actor;
}

async function asAdmin<T>(schoolId: string, fn: (tx: TestDatabase["sql"]) => Promise<T>) {
  return database!.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    return fn(tx as unknown as TestDatabase["sql"]);
  }) as Promise<T>;
}

async function newWorld(): Promise<World> {
  const sql = database!.sql;
  const tenant = await createFullTenant(sql);
  const teacher = { userId: tenant.teachers[0]!.userId, roles: [ROLES.INSTRUCTOR] };
  await assignRole(sql, tenant.schoolId, teacher.userId, ROLES.INSTRUCTOR);
  const student = { userId: tenant.students[0]!.userId, roles: [ROLES.STUDENT] };
  await assignRole(sql, tenant.schoolId, student.userId, ROLES.STUDENT);
  const parent = { userId: tenant.users.PARENT.id, roles: [ROLES.PARENT] };
  const admin = { userId: tenant.users.ORG_ADMIN.id, roles: [ROLES.ORG_ADMIN] };

  // Two more teachers, each leading a class of their own.
  const leadOtherClass = async (): Promise<string> => {
    const other = await createTeacher(sql, tenant.schoolId);
    await assignRole(sql, tenant.schoolId, other.userId, ROLES.INSTRUCTOR);
    await createClass(sql, tenant.schoolId, {
      courseId: tenant.course.id,
      academicYearId: tenant.academicYear.id,
      termId: tenant.term.id,
      leadTeacherId: other.id,
      roomId: tenant.room.id,
    });
    return other.userId;
  };
  const otherTeacher = { userId: await leadOtherClass(), roles: [ROLES.INSTRUCTOR] };
  const teacherParent = {
    userId: await leadOtherClass(),
    roles: [ROLES.INSTRUCTOR, ROLES.PARENT],
  };
  await assignRole(sql, tenant.schoolId, teacherParent.userId, ROLES.PARENT);

  await asAdmin(tenant.schoolId, async (tx) => {
    for (const parentUserId of [parent.userId, teacherParent.userId]) {
      const [family] = await tx<{ id: string }[]>`
        INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
        VALUES (${tenant.schoolId}, 'Test Family', ${parentUserId}) RETURNING id
      `;
      await tx`
        INSERT INTO app.parent_child_links (school_id, parent_user_id, student_id, relationship, family_id)
        VALUES (${tenant.schoolId}, ${parentUserId}, ${tenant.students[0]!.id}, 'guardian', ${family!.id})
      `;
    }
  });

  return { tenant, teacher, admin, student, parent, otherTeacher, teacherParent };
}

type Status = "uploaded" | "ready" | "failed";

interface SeededMaterial {
  id: string;
  storageKey: string;
}

/** A material of the class, uploaded by its teacher, in the given state. */
async function seedMaterial(w: World, status: Status): Promise<SeededMaterial> {
  const storageKey = `permanent/${w.tenant.schoolId}/materials/${crypto.randomUUID()}-notes.pdf`;
  storage.objects.set(storageKey, 1000);
  const [row] = await asAdmin(
    w.tenant.schoolId,
    (tx) => tx<{ id: string }[]>`
      INSERT INTO app.materials (
        school_id, class_id, uploaded_by_user_id, last_edited_by_user_id, title, storage_key,
        original_file_name, mime_type, size_bytes, ingest_status, ingest_error, ingested_at
      ) VALUES (
        ${w.tenant.schoolId}, ${w.tenant.cls.id}, ${w.teacher.userId}, ${w.teacher.userId},
        'Notes', ${storageKey}, ${`${crypto.randomUUID().slice(0, 8)}.pdf`}, 'application/pdf', 1000,
        ${status}::app.material_ingest_status,
        ${status === "failed" ? "failed for test" : null},
        ${status === "ready" ? new Date() : null}
      )
      RETURNING id
    `,
  );
  return { id: row!.id, storageKey };
}

async function materialState(w: World, id: string) {
  const [row] = await asAdmin(
    w.tenant.schoolId,
    (tx) => tx<{ title: string; ingest_status: string; ai_visible: boolean }[]>`
      SELECT title, ingest_status::text AS ingest_status, ai_visible
      FROM app.materials WHERE id = ${id}
    `,
  );
  return row ?? null;
}

async function materialCount(w: World): Promise<number> {
  const [row] = await asAdmin(
    w.tenant.schoolId,
    (tx) => tx<{ count: number }[]>`
      SELECT count(*)::int AS count FROM app.materials WHERE class_id = ${w.tenant.cls.id}
    `,
  );
  return row!.count;
}

function call(w: World, as: Actor, method: string, path: string, body?: unknown) {
  return authenticatedRequest(
    harness!,
    method,
    path,
    { schoolId: w.tenant.schoolId, userId: as.userId, roles: as.roles, channel: "mobile" },
    body === undefined
      ? undefined
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
}

// ---------------------------------------------------------------------------
// The write routes
// ---------------------------------------------------------------------------

interface WriteRoute {
  name: string;
  /** The state the material must be in for the write to succeed. */
  status: Status;
  success: number;
  send: (w: World, as: Actor, material: SeededMaterial) => Promise<Response>;
}

const uploadBody = (w: World) => ({
  class_id: w.tenant.cls.id,
  title: "Worksheet",
  original_file_name: `worksheet-${crypto.randomUUID().slice(0, 8)}.pdf`,
  mime_type: "application/pdf",
  size_bytes: 1000,
});

const BY_ID_ROUTES: WriteRoute[] = [
  {
    name: "POST confirm",
    status: "uploaded",
    success: 200,
    send: (w, as, m) =>
      call(w, as, "POST", `/api/academics/materials/${m.id}/confirm`, {
        storage_key: m.storageKey,
      }),
  },
  {
    name: "PATCH",
    status: "ready",
    success: 200,
    send: (w, as, m) =>
      call(w, as, "PATCH", `/api/academics/materials/${m.id}`, { title: "Renamed" }),
  },
  {
    name: "PATCH ai-visible",
    status: "ready",
    success: 200,
    send: (w, as, m) =>
      call(w, as, "PATCH", `/api/academics/materials/${m.id}/ai-visible`, { ai_visible: false }),
  },
  {
    name: "POST retry",
    status: "failed",
    success: 200,
    send: (w, as, m) => call(w, as, "POST", `/api/academics/materials/${m.id}/retry`),
  },
  {
    name: "DELETE",
    status: "ready",
    success: 204,
    send: (w, as, m) => call(w, as, "DELETE", `/api/academics/materials/${m.id}`),
  },
];

let world: World;

describeDb("material writes", () => {
  beforeAll(async () => {
    world = await newWorld();
  });

  describe("upload", () => {
    for (const who of ["student", "parent", "otherTeacher", "teacherParent"] as const) {
      test(`is refused for the ${who}`, async () => {
        const before = await materialCount(world);
        const res = await call(
          world,
          world[who],
          "POST",
          "/api/academics/materials/upload",
          uploadBody(world),
        );
        expect(res.status).toBe(403);
        expect(await materialCount(world)).toBe(before);
      });
    }

    for (const who of ["teacher", "admin"] as const) {
      test(`succeeds for the ${who}`, async () => {
        const res = await call(
          world,
          world[who],
          "POST",
          "/api/academics/materials/upload",
          uploadBody(world),
        );
        expect(res.status).toBe(201);
      });
    }
  });

  for (const route of BY_ID_ROUTES) {
    describe(route.name, () => {
      // Students and parents can read the class's materials, so only the permission gate stops them.
      for (const who of ["student", "parent"] as const) {
        test(`is refused for the ${who}`, async () => {
          const material = await seedMaterial(world, route.status);
          const before = await materialState(world, material.id);
          const res = await route.send(world, world[who], material);
          expect(res.status).toBe(403);
          expect(await materialState(world, material.id)).toEqual(before);
        });
      }

      // A teacher who can read the class (a parent of an enrolled student) but does not teach it.
      test("is refused for a teacher who does not teach the class", async () => {
        const material = await seedMaterial(world, route.status);
        const before = await materialState(world, material.id);
        const res = await route.send(world, world.teacherParent, material);
        expect(res.status).toBe(403);
        const body = (await res.json()) as { code: string };
        expect(body.code).toBe("MATERIAL_CLASS_FORBIDDEN");
        expect(await materialState(world, material.id)).toEqual(before);
      });

      test("is not found for a teacher of another class", async () => {
        const material = await seedMaterial(world, route.status);
        const before = await materialState(world, material.id);
        const res = await route.send(world, world.otherTeacher, material);
        expect(res.status).toBe(404);
        expect(await materialState(world, material.id)).toEqual(before);
      });

      for (const who of ["teacher", "admin"] as const) {
        test(`succeeds for the ${who}`, async () => {
          const material = await seedMaterial(world, route.status);
          const res = await route.send(world, world[who], material);
          expect(res.status).toBe(route.success);
        });
      }
    });
  }
});
