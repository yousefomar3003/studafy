/**
 * Parent<->teacher messaging: image attachments (000134), blocks (000135), reports and the review
 * queue (000136), and participant profiles (000137).
 *
 * Full HTTP path against a live PostgreSQL with RLS armed; object storage is an in-memory fake that
 * records what lands where. Gated on TEST_DATABASE_URL like every other integration suite.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/messaging/messaging-safety-http.test.ts
 */

import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  assignRole,
  authenticatedRequest,
  createClass,
  createCourse,
  createEnrollment,
  createFullTenant,
  createStudent,
  createSubject,
  createTeacher,
  createTestApp,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import type { StorageService } from "../../src/lib/storage";
import type { TestApp, TestDatabase } from "../harness";
import type { Role } from "@studafy/constants";
import type { TransactionSql } from "postgres";

const describeDb = integrationEnabled ? describe : describe.skip;

// ---------------------------------------------------------------------------
// In-memory object storage
// ---------------------------------------------------------------------------

interface StoredObject {
  contentType: string;
  sizeBytes: number;
}

function fakeStorage(): StorageService & { objects: Map<string, StoredObject> } {
  const objects = new Map<string, StoredObject>();
  const base: StorageService = {
    ttlSeconds: 900,
    check: async () => true,
    presign(key, _method, _contentType, ttlOverrideSeconds) {
      return {
        url: `https://storage.example/${key}?signed`,
        expiresAt: new Date(Date.now() + (ttlOverrideSeconds ?? 900) * 1000),
      };
    },
    async exists(key) {
      return objects.has(key);
    },
    async size(key) {
      return objects.get(key)?.sizeBytes ?? 0;
    },
    async head(key) {
      const object = objects.get(key);
      return object ? { contentType: object.contentType, sizeBytes: object.sizeBytes } : null;
    },
    async checksumSha256() {
      return "a".repeat(64);
    },
    async copy(source, destination) {
      const object = objects.get(source);
      if (object) objects.set(destination, { ...object });
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
  return Object.assign(base, { objects });
}

let database: TestDatabase | undefined;
let harness: TestApp | undefined;
let noStorageHarness: TestApp | undefined;
const storage = fakeStorage();

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  const created = createTestApp({ database: database.sql, storage });
  const plain = createTestApp({ database: database.sql });
  await Promise.all([created.ready, plain.ready]);
  harness = created;
  noStorageHarness = plain;
}, 60_000);

afterAll(async () => {
  harness?.keyStore.destroy();
  noStorageHarness?.keyStore.destroy();
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
  /** The child the main thread is about; in class A, which the teacher leads. */
  studentId: string;
  /** A second child of the parent, in class B (also the teacher's). */
  taughtSiblingId: string;
  /** A third child of the parent, taught only by another teacher. */
  untaughtSiblingId: string;
  classA: { id: string; code: string };
  classB: { id: string; code: string };
  subjectAName: string;
  subjectBName: string;
  parent: Actor;
  teacher: Actor;
  otherParent: Actor;
  principal: Actor;
  orgAdmin: Actor;
}

async function asAdminTx(schoolId: string, fn: (tx: TransactionSql) => Promise<unknown>) {
  await database!.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    await fn(tx);
  });
}

async function linkParent(
  schoolId: string,
  parentUserId: string,
  studentId: string,
  relationship = "mother",
) {
  await asAdminTx(schoolId, async (tx) => {
    const [family] = await tx<{ id: string }[]>`
      INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
      VALUES (${schoolId}, 'Safety test family', ${parentUserId})
      RETURNING id
    `;
    await tx`
      INSERT INTO app.parent_child_links
        (school_id, family_id, parent_user_id, student_id, relationship)
      VALUES (${schoolId}, ${family!.id}, ${parentUserId}, ${studentId}, ${relationship})
    `;
  });
}

async function buildWorld(): Promise<World> {
  const sql = database!.sql;
  const fixture = await createFullTenant(sql);
  const schoolId = fixture.schoolId;

  const teacherProfile = fixture.teachers[0]!;
  await assignRole(sql, schoolId, teacherProfile.userId, ROLES.INSTRUCTOR);

  const subjectB = await createSubject(sql, schoolId, { name: "Physics" });
  const courseB = await createCourse(sql, schoolId, subjectB.id, { name: "Physics 101" });
  const classB = await createClass(sql, schoolId, {
    courseId: courseB.id,
    academicYearId: fixture.academicYear.id,
    termId: fixture.term.id,
    leadTeacherId: teacherProfile.id,
    roomId: fixture.room.id,
  });

  const otherTeacher = await createTeacher(sql, schoolId);
  await assignRole(sql, schoolId, otherTeacher.userId, ROLES.INSTRUCTOR);
  const classC = await createClass(sql, schoolId, {
    courseId: fixture.course.id,
    academicYearId: fixture.academicYear.id,
    termId: fixture.term.id,
    leadTeacherId: otherTeacher.id,
    roomId: fixture.room.id,
  });

  const parentUserId = fixture.users.PARENT.id;
  const studentId = fixture.students[0]!.id;
  await linkParent(schoolId, parentUserId, studentId, "mother");

  const taughtSibling = await createStudent(sql, schoolId, {
    firstName: "Taught",
    lastName: "Sib",
  });
  await createEnrollment(sql, schoolId, classB.id, taughtSibling.id);
  await linkParent(schoolId, parentUserId, taughtSibling.id, "mother");

  const untaughtSibling = await createStudent(sql, schoolId, {
    firstName: "Hidden",
    lastName: "Sib",
  });
  await createEnrollment(sql, schoolId, classC.id, untaughtSibling.id);
  await linkParent(schoolId, parentUserId, untaughtSibling.id, "mother");

  // A classmate in class B who is not the parent's: the parent must never see class B.
  const classmate = await createStudent(sql, schoolId);
  await createEnrollment(sql, schoolId, classB.id, classmate.id);

  const otherParentUser = await createUser(sql, schoolId, {
    email: `other-parent-${crypto.randomUUID().slice(0, 8)}@test.local`,
  });
  await assignRole(sql, schoolId, otherParentUser.id, ROLES.PARENT);

  const principalUser = await createUser(sql, schoolId, {
    email: `principal-${crypto.randomUUID().slice(0, 8)}@test.local`,
    displayName: "Principal Pat",
  });
  await assignRole(sql, schoolId, principalUser.id, ROLES.PRINCIPAL);

  const actor = (userId: string, role: Role): Actor => ({ schoolId, userId, roles: [role] });
  const [subjectA] = await sql<{ name: string }[]>`
    SELECT name FROM app.subjects WHERE id = ${fixture.subject.id}
  `;

  return {
    schoolId,
    studentId,
    taughtSiblingId: taughtSibling.id,
    untaughtSiblingId: untaughtSibling.id,
    classA: { id: fixture.cls.id, code: fixture.cls.code },
    classB: { id: classB.id, code: classB.code },
    subjectAName: subjectA!.name,
    subjectBName: "Physics",
    parent: actor(parentUserId, ROLES.PARENT),
    teacher: actor(teacherProfile.userId, ROLES.INSTRUCTOR),
    otherParent: actor(otherParentUser.id, ROLES.PARENT),
    principal: actor(principalUser.id, ROLES.PRINCIPAL),
    orgAdmin: actor(fixture.users.ORG_ADMIN.id, ROLES.ORG_ADMIN),
  };
}

function request(
  actor: Actor,
  method: string,
  path: string,
  body?: unknown,
  app: TestApp = harness!,
) {
  return authenticatedRequest(
    app,
    method,
    path,
    { channel: "mobile", ...actor },
    body === undefined
      ? undefined
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
}

async function json<T>(res: Response, status: number): Promise<T> {
  const text = await res.text();
  if (res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

interface AttachmentBody {
  id: string;
  content_type: string;
  size_bytes: number;
  download_url: string | null;
  download_url_expires_at: string | null;
}

interface MessageBody {
  id: string;
  sender_id: string;
  body: string;
  attachments: AttachmentBody[];
  created_at: string;
}

interface ConversationBody {
  id: string;
  last_message: { body: string; attachment_count: number } | null;
  blocked_by_me: boolean;
  has_blocked_me: boolean;
}

async function openConversation(world: World): Promise<ConversationBody> {
  const res = await request(world.parent, "POST", "/api/messaging/conversations", {
    student_id: world.studentId,
    teacher_id: world.teacher.userId,
  });
  expect([200, 201]).toContain(res.status);
  return ((await res.json()) as { conversation: ConversationBody }).conversation;
}

async function send(actor: Actor, conversationId: string, payload: unknown): Promise<MessageBody> {
  const res = await request(
    actor,
    "POST",
    `/api/messaging/conversations/${conversationId}/messages`,
    payload,
  );
  return (await json<{ message: MessageBody }>(res, 201)).message;
}

/** Stage an image the way a client does: request-upload, then "PUT" the bytes to the fake bucket. */
async function stageImage(
  actor: Actor,
  options: { contentType?: string; storedType?: string; sizeBytes?: number } = {},
): Promise<string> {
  const contentType = options.contentType ?? "image/jpeg";
  const res = await request(actor, "POST", "/api/storage/uploads/request-upload", {
    content_class: "message.attachment",
    file_name: "photo.jpg",
    content_type: contentType,
    size_bytes: options.sizeBytes ?? 2048,
  });
  const { storage_key } = await json<{ storage_key: string }>(res, 201);
  storage.objects.set(storage_key, {
    contentType: options.storedType ?? contentType,
    sizeBytes: options.sizeBytes ?? 2048,
  });
  return storage_key;
}

async function asUser<T>(
  schoolId: string,
  userId: string,
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  await database!.sql.begin(async (tx) => {
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    await tx.unsafe("SET LOCAL ROLE studafy_app");
    result = await fn(tx);
  });
  return result as T;
}

// ---------------------------------------------------------------------------
// Image attachments
// ---------------------------------------------------------------------------

describeDb("messaging image attachments", () => {
  test("a parent sends text with an image; both participants get a pre-signed URL", async () => {
    const world = await buildWorld();
    const conversation = await openConversation(world);
    const key = await stageImage(world.parent);

    const message = await send(world.parent, conversation.id, {
      body: "Homework photo",
      attachments: [{ storage_key: key }],
    });
    expect(message.body).toBe("Homework photo");
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0]).toMatchObject({ content_type: "image/jpeg", size_bytes: 2048 });
    expect(message.attachments[0]!.download_url).toContain(`permanent/${world.schoolId}/`);

    // Promoted out of temp/.
    expect(storage.objects.has(key)).toBe(false);
    const permanentKey = key.replace(/^temp\//, "permanent/");
    expect(storage.objects.has(permanentKey)).toBe(true);

    const page = await json<{ messages: MessageBody[] }>(
      await request(
        world.teacher,
        "GET",
        `/api/messaging/conversations/${conversation.id}/messages`,
      ),
      200,
    );
    expect(page.messages[0]!.attachments.map((a) => a.id)).toEqual([message.attachments[0]!.id]);
    expect(page.messages[0]!.attachments[0]!.download_url).not.toBeNull();

    const [audit] = await database!.sql<{ attachment_count: string; has_body: boolean }[]>`
      SELECT new_values->>'attachment_count' AS attachment_count,
             (new_values ? 'body') AS has_body
      FROM app.audit_logs
      WHERE school_id = ${world.schoolId} AND target_table = 'messages' AND target_id = ${message.id}
    `;
    expect(audit).toEqual({ attachment_count: "1", has_body: false });

    // The generic confirm route refuses this class: the send owns the confirmation.
    const staged = await stageImage(world.parent);
    const confirm = await request(world.parent, "POST", "/api/storage/uploads/confirm", {
      content_class: "message.attachment",
      storage_key: staged,
    });
    expect(confirm.status).toBe(400);
  });

  test("an image-only message has an empty body, a photo preview and a counted last_message", async () => {
    const world = await buildWorld();
    const conversation = await openConversation(world);
    const keys = [
      await stageImage(world.teacher),
      await stageImage(world.teacher, { contentType: "image/png" }),
    ];

    const message = await send(world.teacher, conversation.id, {
      attachments: keys.map((storage_key) => ({ storage_key })),
    });
    expect(message.body).toBe("");
    expect(message.attachments.map((a) => a.content_type)).toEqual(["image/jpeg", "image/png"]);

    const inbox = await json<{ conversation: ConversationBody }>(
      await request(world.parent, "GET", `/api/messaging/conversations/${conversation.id}`),
      200,
    );
    expect(inbox.conversation.last_message).toMatchObject({ body: "", attachment_count: 2 });

    const [notification] = await database!.sql<{ body: string }[]>`
      SELECT body FROM app.notifications
      WHERE school_id = ${world.schoolId} AND user_id = ${world.parent.userId}
        AND notification_type = 'DIRECT_MESSAGE'
    `;
    expect(notification!.body).toBe("📷 Photo");
  });

  test("bad attachments are refused and leave staged uploads in place", async () => {
    const world = await buildWorld();
    const conversation = await openConversation(world);
    const path = `/api/messaging/conversations/${conversation.id}/messages`;

    const five = await Promise.all([1, 2, 3, 4, 5].map(() => stageImage(world.parent)));
    expect(
      (
        await request(world.parent, "POST", path, {
          attachments: five.map((storage_key) => ({ storage_key })),
        })
      ).status,
    ).toBe(400);

    // Neither text nor images.
    expect((await request(world.parent, "POST", path, { body: "  " })).status).toBe(400);
    expect((await request(world.parent, "POST", path, { attachments: [] })).status).toBe(400);
    // The same upload twice.
    expect(
      (
        await request(world.parent, "POST", path, {
          attachments: [{ storage_key: five[0] }, { storage_key: five[0] }],
        })
      ).status,
    ).toBe(400);

    // request-upload refuses a type outside the class...
    const gif = await request(world.parent, "POST", "/api/storage/uploads/request-upload", {
      content_class: "message.attachment",
      file_name: "anim.gif",
      content_type: "image/gif",
      size_bytes: 100,
    });
    expect(gif.status).toBe(400);
    // ...and the send re-checks the stored object, not the claim.
    const good = await stageImage(world.parent);
    const smuggled = await stageImage(world.parent, { storedType: "application/pdf" });
    const refused = await request(world.parent, "POST", path, {
      body: "two files",
      attachments: [{ storage_key: good }, { storage_key: smuggled }],
    });
    expect(refused.status).toBe(400);
    expect(storage.objects.has(good)).toBe(true);
    expect(storage.objects.has(smuggled)).toBe(true);

    // Oversize stored object.
    const big = await stageImage(world.parent, { sizeBytes: 11 * 1024 * 1024 }).catch(() => null);
    expect(big).toBeNull(); // request-upload already refuses the claim

    // A key from another school is forbidden.
    const foreign = `temp/${crypto.randomUUID()}/${crypto.randomUUID()}/x.jpg`;
    expect(
      (await request(world.parent, "POST", path, { attachments: [{ storage_key: foreign }] }))
        .status,
    ).toBe(403);

    const [count] = await database!.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM app.messages WHERE conversation_id = ${conversation.id}
    `;
    expect(count!.n).toBe(0);
  });

  test("without object storage, images answer 503 and text still sends", async () => {
    const world = await buildWorld();
    const conversation = await openConversation(world);
    const path = `/api/messaging/conversations/${conversation.id}/messages`;
    const key = `temp/${world.schoolId}/${crypto.randomUUID()}/photo.jpg`;

    const res = await request(
      world.parent,
      "POST",
      path,
      { attachments: [{ storage_key: key }] },
      noStorageHarness!,
    );
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe("STORAGE_NOT_CONFIGURED");

    const text = await request(world.parent, "POST", path, { body: "plain" }, noStorageHarness!);
    expect(text.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

interface ProfileBody {
  user_id: string;
  name: string;
  role: string;
  blocked_by_me: boolean;
  has_blocked_me: boolean;
  classes: { id: string; code: string; course_name: string | null; subject_name: string | null }[];
  subjects: string[];
  relationship: string | null;
  children: {
    id: string;
    relationship: string;
    is_conversation_student: boolean;
    classes: { id: string }[];
  }[];
}

describeDb("messaging participant profiles", () => {
  test("a parent sees the teacher's classes for this child and all their subjects", async () => {
    const world = await buildWorld();
    const conversation = await openConversation(world);
    const { profile } = await json<{ profile: ProfileBody }>(
      await request(world.parent, "GET", `/api/messaging/conversations/${conversation.id}/profile`),
      200,
    );
    expect(profile).toMatchObject({
      user_id: world.teacher.userId,
      role: "teacher",
      blocked_by_me: false,
      has_blocked_me: false,
      relationship: null,
      children: [],
    });
    // Class B is the teacher's too, but this thread's child is not in it.
    expect(profile.classes.map((c) => c.id)).toEqual([world.classA.id]);
    expect(profile.classes[0]!.subject_name).toBe(world.subjectAName);
    expect([...profile.subjects].sort()).toEqual([world.subjectAName, world.subjectBName].sort());
    // No contact fields. (`name` follows the inbox's display-name convention.)
    expect(Object.keys(profile).some((key) => /email|phone/.test(key))).toBe(false);
  });

  test("a teacher sees only the parent's children they teach", async () => {
    const world = await buildWorld();
    const conversation = await openConversation(world);
    const { profile } = await json<{ profile: ProfileBody }>(
      await request(
        world.teacher,
        "GET",
        `/api/messaging/conversations/${conversation.id}/profile`,
      ),
      200,
    );
    expect(profile).toMatchObject({
      user_id: world.parent.userId,
      role: "parent",
      relationship: "mother",
      classes: [],
      subjects: [],
    });
    const children = new Map(profile.children.map((child) => [child.id, child]));
    expect([...children.keys()].sort()).toEqual([world.studentId, world.taughtSiblingId].sort());
    expect(children.has(world.untaughtSiblingId)).toBe(false);
    expect(children.get(world.studentId)!.is_conversation_student).toBe(true);
    expect(children.get(world.studentId)!.classes.map((c) => c.id)).toEqual([world.classA.id]);
    expect(children.get(world.taughtSiblingId)!.classes.map((c) => c.id)).toEqual([
      world.classB.id,
    ]);
  });

  test("non-participants get 404, and the helpers answer nobody else", async () => {
    const world = await buildWorld();
    const conversation = await openConversation(world);
    const path = `/api/messaging/conversations/${conversation.id}/profile`;
    expect((await request(world.otherParent, "GET", path)).status).toBe(404);

    const rows = await asUser(world.schoolId, world.otherParent.userId, async (tx) => {
      const [row] = await tx<{ a: number; b: number; c: number }[]>`
        SELECT
          (SELECT count(*)::int FROM app.message_profile_teacher_classes(${conversation.id}::uuid)) AS a,
          (SELECT count(*)::int FROM app.message_profile_teacher_subjects(${conversation.id}::uuid)) AS b,
          (SELECT count(*)::int FROM app.message_profile_parent_children(${conversation.id}::uuid)) AS c
      `;
      return row!;
    });
    expect(rows).toEqual({ a: 0, b: 0, c: 0 });
  });
});

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

describeDb("messaging blocks", () => {
  test("a block stops sending and opening threads both ways; unblock restores", async () => {
    const world = await buildWorld();
    const conversation = await openConversation(world);
    const base = `/api/messaging/conversations/${conversation.id}`;
    await send(world.parent, conversation.id, { body: "Before the block" });

    expect(await json<unknown>(await request(world.parent, "POST", `${base}/block`), 201)).toEqual({
      blocked_by_me: true,
      has_blocked_me: false,
    });
    // Idempotent.
    expect((await request(world.parent, "POST", `${base}/block`)).status).toBe(200);

    for (const actor of [world.parent, world.teacher]) {
      const res = await request(actor, "POST", `${base}/messages`, { body: "hello?" });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe("MESSAGING_BLOCKED");
    }
    const parentOpen = await request(world.parent, "POST", "/api/messaging/conversations", {
      student_id: world.studentId,
      teacher_id: world.teacher.userId,
    });
    expect(parentOpen.status).toBe(403);
    expect(((await parentOpen.json()) as { code: string }).code).toBe("MESSAGING_BLOCKED");
    const teacherOpen = await request(
      world.teacher,
      "POST",
      "/api/messaging/teacher-conversations",
      {
        student_id: world.taughtSiblingId,
        parent_id: world.parent.userId,
      },
    );
    expect(teacherOpen.status).toBe(403);
    expect(((await teacherOpen.json()) as { code: string }).code).toBe("MESSAGING_BLOCKED");

    // History stays readable, and both sides see the state.
    const history = await json<{ messages: MessageBody[] }>(
      await request(world.teacher, "GET", `${base}/messages`),
      200,
    );
    expect(history.messages.map((m) => m.body)).toEqual(["Before the block"]);
    const teacherView = await json<{ conversation: ConversationBody }>(
      await request(world.teacher, "GET", base),
      200,
    );
    expect(teacherView.conversation).toMatchObject({ blocked_by_me: false, has_blocked_me: true });
    const parentInbox = await json<{ conversations: ConversationBody[] }>(
      await request(world.parent, "GET", "/api/messaging/conversations"),
      200,
    );
    expect(parentInbox.conversations[0]).toMatchObject({
      blocked_by_me: true,
      has_blocked_me: false,
    });
    const profile = await json<{ profile: ProfileBody }>(
      await request(world.teacher, "GET", `${base}/profile`),
      200,
    );
    expect(profile.profile).toMatchObject({ blocked_by_me: false, has_blocked_me: true });

    // The teacher cannot lift the parent's block.
    expect((await request(world.teacher, "DELETE", `${base}/block`)).status).toBe(204);
    expect(
      (await request(world.teacher, "POST", `${base}/messages`, { body: "still?" })).status,
    ).toBe(403);

    expect((await request(world.parent, "DELETE", `${base}/block`)).status).toBe(204);
    await send(world.teacher, conversation.id, { body: "After the block" });

    const audit = await database!.sql<{ action: string }[]>`
      SELECT action::text AS action FROM app.audit_logs
      WHERE school_id = ${world.schoolId} AND target_table = 'message_blocks'
      ORDER BY created_at
    `;
    expect(audit.map((row) => row.action)).toEqual(["insert", "delete"]);
  });

  test("RLS: a blocked pair cannot insert a message or a thread, and blocks are private", async () => {
    const world = await buildWorld();
    const conversation = await openConversation(world);
    expect(
      (
        await request(
          world.teacher,
          "POST",
          `/api/messaging/conversations/${conversation.id}/block`,
        )
      ).status,
    ).toBe(201);

    const refused = async (userId: string, run: (tx: TransactionSql) => Promise<unknown>) => {
      try {
        await asUser(world.schoolId, userId, run);
        return false;
      } catch (error) {
        if (/row-level security/.test(String(error))) return true;
        throw error;
      }
    };
    expect(
      await refused(
        world.parent.userId,
        (tx) => tx`
          INSERT INTO app.messages (school_id, conversation_id, sender_user_id, body)
          VALUES (${world.schoolId}, ${conversation.id}, ${world.parent.userId}, 'bypass')
        `,
      ),
    ).toBe(true);
    expect(
      await refused(
        world.parent.userId,
        (tx) => tx`
          INSERT INTO app.message_conversations (school_id, parent_user_id, teacher_user_id, student_id)
          VALUES (${world.schoolId}, ${world.parent.userId}, ${world.teacher.userId}, ${world.taughtSiblingId})
        `,
      ),
    ).toBe(true);
    // Messages are append-only for studafy_app: no UPDATE or DELETE privilege at all.
    for (const statement of [
      `UPDATE app.messages SET body = 'edited' WHERE conversation_id = '${conversation.id}'`,
      `DELETE FROM app.messages WHERE conversation_id = '${conversation.id}'`,
      `UPDATE app.message_conversations SET student_id = student_id WHERE id = '${conversation.id}'`,
    ]) {
      let denied = false;
      try {
        await asUser(world.schoolId, world.teacher.userId, (tx) => tx.unsafe(statement));
      } catch (error) {
        denied = /permission denied/.test(String(error));
      }
      expect(denied).toBe(true);
    }
    // The parent cannot see (or delete) the teacher's block row.
    const visible = await asUser(world.schoolId, world.parent.userId, async (tx) => {
      const [row] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM app.message_blocks`;
      return row!.n;
    });
    expect(visible).toBe(0);
    // Nobody can block a user they share no thread with.
    expect(
      await refused(
        world.otherParent.userId,
        (tx) => tx`
          INSERT INTO app.message_blocks (school_id, blocker_user_id, blocked_user_id)
          VALUES (${world.schoolId}, ${world.otherParent.userId}, ${world.teacher.userId})
        `,
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

interface ReportBody {
  id: string;
  status: string;
  priority: string;
  reason_category: string;
  message_id: string | null;
  reporter: { id: string; role: string };
  reported: { id: string; role: string };
  student: { id: string; name: string };
  block_exists: boolean;
  resolution_note: string | null;
  reviewed_by: { id: string } | null;
}

interface ReportDetailBody extends ReportBody {
  messages: {
    id: string;
    sender_id: string;
    sender_name: string;
    body: string;
    is_reported: boolean;
    attachments: AttachmentBody[];
  }[];
}

describeDb("messaging reports and the review queue", () => {
  test("filing: one open report per message or thread, snapshots the evidence", async () => {
    const world = await buildWorld();
    const conversation = await openConversation(world);
    const base = `/api/messaging/conversations/${conversation.id}`;

    const sent: MessageBody[] = [];
    for (let i = 1; i <= 24; i += 1) {
      sent.push(
        await send(i % 2 ? world.teacher : world.parent, conversation.id, { body: `m${i}` }),
      );
    }
    const imageKey = await stageImage(world.teacher);
    const withImage = await send(world.teacher, conversation.id, {
      body: "the bad one",
      attachments: [{ storage_key: imageKey }],
    });
    await send(world.parent, conversation.id, { body: "after" });

    const created = await json<{ report: ReportBody; block: { blocked_by_me: boolean } }>(
      await request(world.parent, "POST", `${base}/reports`, {
        message_id: withImage.id,
        reason_category: "harassment",
        details: "Not OK",
      }),
      201,
    );
    expect(created.report).toMatchObject({
      status: "pending",
      priority: "high",
      message_id: withImage.id,
    });
    expect(created.block.blocked_by_me).toBe(false);

    const duplicate = await request(world.parent, "POST", `${base}/reports`, {
      message_id: withImage.id,
      reason_category: "spam",
    });
    expect(duplicate.status).toBe(409);
    expect(((await duplicate.json()) as { code: string }).code).toBe("MESSAGE_REPORT_ALREADY_OPEN");

    // A general report, with a block in the same call; a second one is a duplicate.
    const general = await json<{ report: ReportBody; block: { blocked_by_me: boolean } }>(
      await request(world.parent, "POST", `${base}/reports`, {
        reason_category: "safety_concern",
        also_block: true,
      }),
      201,
    );
    expect(general.report).toMatchObject({ priority: "urgent", message_id: null });
    expect(general.block.blocked_by_me).toBe(true);
    expect(
      (await request(world.parent, "POST", `${base}/reports`, { reason_category: "other" })).status,
    ).toBe(409);

    // Outsiders and foreign messages.
    expect(
      (await request(world.otherParent, "POST", `${base}/reports`, { reason_category: "spam" }))
        .status,
    ).toBe(404);
    expect(
      (
        await request(world.parent, "POST", `${base}/reports`, {
          message_id: crypto.randomUUID(),
          reason_category: "spam",
        })
      ).status,
    ).toBe(404);

    // The principal reads the snapshot: the reported message and the 20 before it.
    const detail = await json<{ report: ReportDetailBody }>(
      await request(world.principal, "GET", `/api/messaging/reports/${created.report.id}`),
      200,
    );
    expect(detail.report.messages).toHaveLength(21);
    expect(detail.report.messages.at(-1)).toMatchObject({
      id: withImage.id,
      body: "the bad one",
      is_reported: true,
      sender_id: world.teacher.userId,
    });
    expect(detail.report.messages[0]!.body).toBe("m5");
    expect(detail.report.messages.filter((m) => m.is_reported)).toHaveLength(1);
    expect(detail.report.messages.at(-1)!.attachments).toHaveLength(1);
    expect(detail.report.messages.at(-1)!.attachments[0]!.download_url).toContain("permanent/");
    expect(detail.report.reporter).toMatchObject({ id: world.parent.userId, role: "parent" });
    expect(detail.report.reported).toMatchObject({ id: world.teacher.userId, role: "teacher" });
    expect(detail.report.student.id).toBe(world.studentId);
    expect(detail.report.block_exists).toBe(true);

    // The general report captures the thread's last 20.
    const generalDetail = await json<{ report: ReportDetailBody }>(
      await request(world.orgAdmin, "GET", `/api/messaging/reports/${general.report.id}`),
      200,
    );
    expect(generalDetail.report.messages).toHaveLength(20);
    expect(generalDetail.report.messages.at(-1)!.body).toBe("after");
    expect(generalDetail.report.messages.some((m) => m.is_reported)).toBe(false);

    // No free text in the audit trail.
    const audit = await database!.sql<{ has_details: boolean }[]>`
      SELECT (new_values ? 'details') AS has_details FROM app.audit_logs
      WHERE school_id = ${world.schoolId} AND target_table = 'message_reports'
    `;
    expect(audit).toHaveLength(2);
    expect(audit.every((row) => !row.has_details)).toBe(true);
  });

  test("reviewers list and resolve; participants are refused the queue", async () => {
    const world = await buildWorld();
    const conversation = await openConversation(world);
    const message = await send(world.teacher, conversation.id, { body: "rude" });
    const { report } = await json<{ report: ReportBody }>(
      await request(
        world.parent,
        "POST",
        `/api/messaging/conversations/${conversation.id}/reports`,
        {
          message_id: message.id,
          reason_category: "inappropriate",
        },
      ),
      201,
    );
    // The teacher reports the parent in general, too.
    await json(
      await request(
        world.teacher,
        "POST",
        `/api/messaging/conversations/${conversation.id}/reports`,
        {
          reason_category: "spam",
        },
      ),
      201,
    );

    for (const actor of [world.parent, world.teacher]) {
      expect((await request(actor, "GET", "/api/messaging/reports")).status).toBe(403);
      expect((await request(actor, "GET", `/api/messaging/reports/${report.id}`)).status).toBe(403);
      expect(
        (
          await request(actor, "PATCH", `/api/messaging/reports/${report.id}`, {
            status: "in_review",
          })
        ).status,
      ).toBe(403);
    }

    const queue = await json<{ reports: ReportBody[]; total: number }>(
      await request(world.principal, "GET", "/api/messaging/reports?status=open"),
      200,
    );
    expect(queue.total).toBe(2);
    // high (inappropriate) before normal (spam).
    expect(queue.reports.map((r) => r.priority)).toEqual(["high", "normal"]);
    expect(queue.reports[1]!.reporter).toMatchObject({ id: world.teacher.userId, role: "teacher" });

    const path = `/api/messaging/reports/${report.id}`;
    const inReview = await json<{ report: ReportBody }>(
      await request(world.principal, "PATCH", path, { status: "in_review" }),
      200,
    );
    expect(inReview.report).toMatchObject({
      status: "in_review",
      reviewed_by: { id: world.principal.userId },
    });
    expect((await request(world.principal, "PATCH", path, { status: "actioned" })).status).toBe(
      400,
    );
    const closed = await json<{ report: ReportBody }>(
      await request(world.principal, "PATCH", path, {
        status: "actioned",
        resolution_note: "Spoke to the teacher.",
      }),
      200,
    );
    expect(closed.report).toMatchObject({
      status: "actioned",
      resolution_note: "Spoke to the teacher.",
    });
    const again = await request(world.principal, "PATCH", path, {
      status: "dismissed",
      resolution_note: "x",
    });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { code: string }).code).toBe(
      "MESSAGE_REPORT_INVALID_TRANSITION",
    );
    expect(
      (await request(world.principal, "GET", `/api/messaging/reports/${crypto.randomUUID()}`))
        .status,
    ).toBe(404);

    // Once closed, the same message can be reported again.
    expect(
      (
        await request(
          world.parent,
          "POST",
          `/api/messaging/conversations/${conversation.id}/reports`,
          {
            message_id: message.id,
            reason_category: "inappropriate",
          },
        )
      ).status,
    ).toBe(201);

    const actioned = await json<{ reports: ReportBody[] }>(
      await request(world.orgAdmin, "GET", "/api/messaging/reports?status=actioned"),
      200,
    );
    expect(actioned.reports.map((r) => r.id)).toEqual([report.id]);
  });

  test("RLS: snapshots are reviewer-only; reporters see only their own reports", async () => {
    const world = await buildWorld();
    const conversation = await openConversation(world);
    const message = await send(world.teacher, conversation.id, { body: "evidence" });
    const { report } = await json<{ report: ReportBody }>(
      await request(
        world.parent,
        "POST",
        `/api/messaging/conversations/${conversation.id}/reports`,
        {
          message_id: message.id,
          reason_category: "other",
        },
      ),
      201,
    );

    const counts = (userId: string) =>
      asUser(world.schoolId, userId, async (tx) => {
        const [row] = await tx<{ reports: number; snapshot: number }[]>`
          SELECT
            (SELECT count(*)::int FROM app.message_reports) AS reports,
            (SELECT count(*)::int FROM app.message_report_messages) AS snapshot
        `;
        return row!;
      });
    expect(await counts(world.parent.userId)).toEqual({ reports: 1, snapshot: 0 });
    expect(await counts(world.teacher.userId)).toEqual({ reports: 0, snapshot: 0 });
    expect(await counts(world.principal.userId)).toEqual({ reports: 1, snapshot: 1 });

    // A participant cannot forge evidence or close their own report.
    let refused = false;
    try {
      await asUser(
        world.schoolId,
        world.parent.userId,
        (tx) => tx`
          INSERT INTO app.message_report_messages
            (school_id, report_id, message_id, position, sender_user_id, sender_name, body, message_created_at)
          VALUES (${world.schoolId}, ${report.id}, ${message.id}, 5, ${world.teacher.userId}, 'x', 'forged', now())
        `,
      );
    } catch (error) {
      refused = /permission denied/.test(String(error));
    }
    expect(refused).toBe(true);
    const updated = await asUser(world.schoolId, world.parent.userId, async (tx) => {
      const rows = await tx`
        UPDATE app.message_reports SET status = 'dismissed', resolution_note = 'mine'
        WHERE id = ${report.id}
        RETURNING id
      `;
      return rows.length;
    });
    expect(updated).toBe(0);
  });
});
