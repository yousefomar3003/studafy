/**
 * Parent<->teacher messaging HTTP tests (000127; teacher-initiated threads 000130).
 *
 * Full HTTP path — JWT auth, channel and permission gates, a real tenant transaction with RLS armed,
 * the in-app notification and the audit rows the service writes — for /api/messaging. Requires a
 * live PostgreSQL instance, gated on TEST_DATABASE_URL like every other integration suite.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/messaging/messaging-http.test.ts
 */

import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  assignRole,
  authenticatedRequest,
  createFullTenant,
  createStudent,
  createTeacher,
  createTestApp,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import type { AuthChannel } from "../../src/modules/auth/channels";
import type { TestApp, TestDatabase } from "../harness";
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
  channel?: AuthChannel;
}

interface World {
  schoolId: string;
  studentId: string;
  classId: string;
  classCode: string;
  parent: Actor;
  teacher: Actor;
  /** An INSTRUCTOR with a teacher profile who teaches nothing the child is enrolled in. */
  otherTeacher: Actor;
  /** A PARENT with no link to the child. */
  otherParent: Actor;
  /** A child the parent is NOT linked to. */
  unlinkedStudentId: string;
}

async function linkParent(
  schoolId: string,
  parentUserId: string,
  studentId: string,
  relationship = "father",
) {
  await database!.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    const [family] = await tx<{ id: string }[]>`
      INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
      VALUES (${schoolId}, 'Messaging test family', ${parentUserId})
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
  const fixture = await createFullTenant(database!.sql);
  const sql = database!.sql;
  const schoolId = fixture.schoolId;

  // The fixture's lead teacher has a profile but no role; messaging requires a teaching role.
  const teacherProfile = fixture.teachers[0]!;
  await assignRole(sql, schoolId, teacherProfile.userId, ROLES.INSTRUCTOR);

  const otherProfile = await createTeacher(sql, schoolId);
  await assignRole(sql, schoolId, otherProfile.userId, ROLES.INSTRUCTOR);

  const parentUserId = fixture.users.PARENT.id;
  const studentId = fixture.students[0]!.id;
  await linkParent(schoolId, parentUserId, studentId);

  const otherParentUser = await createUser(sql, schoolId, {
    email: `other-parent-${crypto.randomUUID().slice(0, 8)}@test.local`,
  });
  await assignRole(sql, schoolId, otherParentUser.id, ROLES.PARENT);

  const unlinked = await createStudent(sql, schoolId);

  const actor = (userId: string, role: Role): Actor => ({
    schoolId,
    userId,
    roles: [role],
    channel: "mobile",
  });

  return {
    schoolId,
    studentId,
    classId: fixture.cls.id,
    classCode: fixture.cls.code,
    parent: actor(parentUserId, ROLES.PARENT),
    teacher: actor(teacherProfile.userId, ROLES.INSTRUCTOR),
    otherTeacher: actor(otherProfile.userId, ROLES.INSTRUCTOR),
    otherParent: actor(otherParentUser.id, ROLES.PARENT),
    unlinkedStudentId: unlinked.id,
  };
}

function request(actor: Actor, method: string, path: string, body?: unknown) {
  return authenticatedRequest(
    harness!,
    method,
    path,
    { channel: "mobile", ...actor },
    body === undefined
      ? undefined
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
}

interface ConversationBody {
  id: string;
  student: { id: string; name: string };
  parent: { id: string; name: string };
  teacher: { id: string; name: string };
  last_message: { body: string; sender_id: string; created_at: string } | null;
  unread_count: number;
  updated_at: string;
}

interface MessageBody {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string;
  created_at: string;
}

async function openConversation(world: World): Promise<ConversationBody> {
  const res = await request(world.parent, "POST", "/api/messaging/conversations", {
    student_id: world.studentId,
    teacher_id: world.teacher.userId,
  });
  expect([200, 201]).toContain(res.status);
  return ((await res.json()) as { conversation: ConversationBody }).conversation;
}

async function send(actor: Actor, conversationId: string, body: string): Promise<MessageBody> {
  const res = await request(
    actor,
    "POST",
    `/api/messaging/conversations/${conversationId}/messages`,
    { body },
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { message: MessageBody }).message;
}

async function messages(actor: Actor, conversationId: string, query = "") {
  const res = await request(
    actor,
    "GET",
    `/api/messaging/conversations/${conversationId}/messages${query}`,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { messages: MessageBody[]; has_more: boolean };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeDb("messaging HTTP", () => {
  test("a parent lists the child's teachers as contacts; only for a linked child", async () => {
    const world = await buildWorld();

    const res = await request(
      world.parent,
      "GET",
      `/api/messaging/contacts?student_id=${world.studentId}`,
    );
    expect(res.status).toBe(200);
    const { contacts } = (await res.json()) as {
      contacts: {
        teacher_id: string;
        name: string;
        classes: { id: string; code: string; course_name: string | null }[];
        conversation_id: string | null;
      }[];
    };
    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({
      teacher_id: world.teacher.userId,
      classes: [{ id: world.classId, code: world.classCode }],
      conversation_id: null,
    });

    // Once a thread exists, the contact carries its id.
    const conversation = await openConversation(world);
    const again = (await (
      await request(world.parent, "GET", `/api/messaging/contacts?student_id=${world.studentId}`)
    ).json()) as { contacts: { conversation_id: string | null }[] };
    expect(again.contacts[0]!.conversation_id).toBe(conversation.id);

    expect(
      (
        await request(
          world.parent,
          "GET",
          `/api/messaging/contacts?student_id=${world.unlinkedStudentId}`,
        )
      ).status,
    ).toBe(404);
    expect(
      (await request(world.teacher, "GET", `/api/messaging/contacts?student_id=${world.studentId}`))
        .status,
    ).toBe(403);
  });

  test("opening a conversation is get-or-create and enforces the messaging rule", async () => {
    const world = await buildWorld();
    const body = { student_id: world.studentId, teacher_id: world.teacher.userId };

    const first = await request(world.parent, "POST", "/api/messaging/conversations", body);
    expect(first.status).toBe(201);
    const created = ((await first.json()) as { conversation: ConversationBody }).conversation;
    expect(created).toMatchObject({
      student: { id: world.studentId, name: "Primary TestStudent" },
      parent: { id: world.parent.userId },
      teacher: { id: world.teacher.userId },
      last_message: null,
      unread_count: 0,
    });

    const second = await request(world.parent, "POST", "/api/messaging/conversations", body);
    expect(second.status).toBe(200);
    expect(((await second.json()) as { conversation: ConversationBody }).conversation.id).toBe(
      created.id,
    );

    // A teacher who does not teach the child.
    expect(
      (
        await request(world.parent, "POST", "/api/messaging/conversations", {
          student_id: world.studentId,
          teacher_id: world.otherTeacher.userId,
        })
      ).status,
    ).toBe(403);
    // A child not linked to the caller.
    expect(
      (
        await request(world.parent, "POST", "/api/messaging/conversations", {
          student_id: world.unlinkedStudentId,
          teacher_id: world.teacher.userId,
        })
      ).status,
    ).toBe(404);
    // Teachers do not open threads.
    expect(
      (await request(world.teacher, "POST", "/api/messaging/conversations", body)).status,
    ).toBe(403);

    const audit = await database!.sql<{ action: string }[]>`
      SELECT action::text AS action FROM app.audit_logs
      WHERE school_id = ${world.schoolId} AND target_table = 'message_conversations'
        AND target_id = ${created.id}
    `;
    expect(audit.map((row) => row.action)).toEqual(["insert"]);
  });

  test("a teacher lists the parents of the students they teach", async () => {
    const world = await buildWorld();
    const sql = database!.sql;

    // A second, active guardian of the same child, and one who could not read a message.
    const mother = await createUser(sql, world.schoolId, {
      email: `mother-${crypto.randomUUID().slice(0, 8)}@test.local`,
      displayName: "A Mother",
    });
    await assignRole(sql, world.schoolId, mother.id, ROLES.PARENT);
    await linkParent(world.schoolId, mother.id, world.studentId, "mother");
    const suspended = await createUser(sql, world.schoolId, {
      email: `suspended-${crypto.randomUUID().slice(0, 8)}@test.local`,
      status: "suspended",
    });
    await assignRole(sql, world.schoolId, suspended.id, ROLES.PARENT);
    await linkParent(world.schoolId, suspended.id, world.studentId, "guardian");
    // A linked parent of a child the teacher does not teach is not offered.
    await linkParent(world.schoolId, world.otherParent.userId, world.unlinkedStudentId);

    const res = await request(world.teacher, "GET", "/api/messaging/teacher-contacts");
    expect(res.status).toBe(200);
    const { students } = (await res.json()) as {
      students: {
        id: string;
        name: string;
        classes: { id: string; code: string; course_name: string | null }[];
        parents: {
          parent_id: string;
          name: string;
          relationship: string;
          conversation_id: string | null;
        }[];
      }[];
    };
    expect(students).toHaveLength(1);
    expect(students[0]).toMatchObject({
      id: world.studentId,
      name: "Primary TestStudent",
      classes: [{ id: world.classId, code: world.classCode }],
    });
    expect(students[0]!.parents).toEqual([
      { parent_id: mother.id, name: "A Mother", relationship: "mother", conversation_id: null },
      {
        parent_id: world.parent.userId,
        name: "PARENT User",
        relationship: "father",
        conversation_id: null,
      },
    ]);

    // A thread the parent started shows up on the teacher's side too.
    const conversation = await openConversation(world);
    const again = (await (
      await request(world.teacher, "GET", "/api/messaging/teacher-contacts")
    ).json()) as {
      students: { parents: { parent_id: string; conversation_id: string | null }[] }[];
    };
    expect(
      again.students[0]!.parents.find((p) => p.parent_id === world.parent.userId)!.conversation_id,
    ).toBe(conversation.id);

    const other = (await (
      await request(world.otherTeacher, "GET", "/api/messaging/teacher-contacts")
    ).json()) as { students: unknown[] };
    expect(other.students).toEqual([]);

    expect((await request(world.parent, "GET", "/api/messaging/teacher-contacts")).status).toBe(
      403,
    );
  });

  test("a teacher opens a conversation with a parent; get-or-create with the parent's side", async () => {
    const world = await buildWorld();
    const body = { student_id: world.studentId, parent_id: world.parent.userId };

    const first = await request(
      world.teacher,
      "POST",
      "/api/messaging/teacher-conversations",
      body,
    );
    expect(first.status).toBe(201);
    const created = ((await first.json()) as { conversation: ConversationBody }).conversation;
    expect(created).toMatchObject({
      student: { id: world.studentId, name: "Primary TestStudent" },
      parent: { id: world.parent.userId },
      teacher: { id: world.teacher.userId },
      last_message: null,
      unread_count: 0,
    });

    const second = await request(
      world.teacher,
      "POST",
      "/api/messaging/teacher-conversations",
      body,
    );
    expect(second.status).toBe(200);
    expect(((await second.json()) as { conversation: ConversationBody }).conversation.id).toBe(
      created.id,
    );

    // The parent opening "their" thread with this teacher lands on the same row.
    const fromParent = await request(world.parent, "POST", "/api/messaging/conversations", {
      student_id: world.studentId,
      teacher_id: world.teacher.userId,
    });
    expect(fromParent.status).toBe(200);
    expect(((await fromParent.json()) as { conversation: ConversationBody }).conversation.id).toBe(
      created.id,
    );

    // The teacher writes first; the parent is notified.
    await send(world.teacher, created.id, "Hello from school");
    const parentInbox = (await (
      await request(world.parent, "GET", "/api/messaging/conversations")
    ).json()) as { conversations: ConversationBody[] };
    expect(parentInbox.conversations[0]).toMatchObject({ id: created.id, unread_count: 1 });

    const refusals: [Actor, { student_id: string; parent_id: string }][] = [
      // A parent not linked to the student.
      [world.teacher, { student_id: world.studentId, parent_id: world.otherParent.userId }],
      // A student the teacher does not teach.
      [world.teacher, { student_id: world.unlinkedStudentId, parent_id: world.parent.userId }],
      // A teacher who does not teach the student.
      [world.otherTeacher, body],
      // Not a parent at all: the teacher themselves.
      [world.teacher, { student_id: world.studentId, parent_id: world.teacher.userId }],
    ];
    for (const [actor, payload] of refusals) {
      expect(
        (await request(actor, "POST", "/api/messaging/teacher-conversations", payload)).status,
      ).toBe(403);
    }
    // Parents use their own endpoint.
    expect(
      (await request(world.parent, "POST", "/api/messaging/teacher-conversations", body)).status,
    ).toBe(403);

    const audit = await database!.sql<{ action: string }[]>`
      SELECT action::text AS action FROM app.audit_logs
      WHERE school_id = ${world.schoolId} AND target_table = 'message_conversations'
        AND target_id = ${created.id}
    `;
    expect(audit.map((row) => row.action)).toEqual(["insert"]);
  });

  test("a teacher cannot message a parent who could not read it", async () => {
    const world = await buildWorld();
    const sql = database!.sql;
    const suspended = await createUser(sql, world.schoolId, {
      email: `suspended-${crypto.randomUUID().slice(0, 8)}@test.local`,
      status: "suspended",
    });
    await assignRole(sql, world.schoolId, suspended.id, ROLES.PARENT);
    await linkParent(world.schoolId, suspended.id, world.studentId);
    const notAParent = await createUser(sql, world.schoolId, {
      email: `no-role-${crypto.randomUUID().slice(0, 8)}@test.local`,
    });
    await linkParent(world.schoolId, notAParent.id, world.studentId);

    for (const parentId of [suspended.id, notAParent.id]) {
      expect(
        (
          await request(world.teacher, "POST", "/api/messaging/teacher-conversations", {
            student_id: world.studentId,
            parent_id: parentId,
          })
        ).status,
      ).toBe(403);
    }
  });

  test("sending, unread counts, read markers and the recipient's notification", async () => {
    const world = await buildWorld();
    const conversation = await openConversation(world);

    const first = await send(world.parent, conversation.id, "  Hello Ms. Teacher  ");
    expect(first).toMatchObject({
      conversation_id: conversation.id,
      sender_id: world.parent.userId,
      body: "Hello Ms. Teacher",
    });
    const second = await send(world.parent, conversation.id, "How is Primary doing?");

    const teacherInbox = (await (
      await request(world.teacher, "GET", "/api/messaging/conversations")
    ).json()) as { conversations: ConversationBody[] };
    expect(teacherInbox.conversations).toHaveLength(1);
    expect(teacherInbox.conversations[0]).toMatchObject({
      id: conversation.id,
      unread_count: 2,
      last_message: { body: second.body, sender_id: world.parent.userId },
      updated_at: second.created_at,
    });

    // The sender's own messages never count as unread for them.
    const parentView = (await (
      await request(world.parent, "GET", `/api/messaging/conversations/${conversation.id}`)
    ).json()) as { conversation: ConversationBody };
    expect(parentView.conversation.unread_count).toBe(0);

    const read = await request(
      world.teacher,
      "POST",
      `/api/messaging/conversations/${conversation.id}/read`,
    );
    expect(read.status).toBe(204);
    const afterRead = (await (
      await request(world.teacher, "GET", `/api/messaging/conversations/${conversation.id}`)
    ).json()) as { conversation: ConversationBody };
    expect(afterRead.conversation.unread_count).toBe(0);

    const reply = await send(world.teacher, conversation.id, "Doing great, thanks!");
    const parentInbox = (await (
      await request(
        world.parent,
        "GET",
        `/api/messaging/conversations?student_id=${world.studentId}`,
      )
    ).json()) as { conversations: ConversationBody[] };
    expect(parentInbox.conversations[0]).toMatchObject({ id: conversation.id, unread_count: 1 });

    const notifications = await database!.sql<
      { user_id: string; notification_type: string; body: string; metadata: unknown }[]
    >`
      SELECT user_id, notification_type::text AS notification_type, body, metadata
      FROM app.notifications
      WHERE school_id = ${world.schoolId} AND notification_type = 'DIRECT_MESSAGE'
      ORDER BY created_at, user_id
    `;
    expect(notifications.map((row) => row.user_id)).toEqual([
      world.teacher.userId,
      world.teacher.userId,
      world.parent.userId,
    ]);
    expect(notifications[2]).toMatchObject({
      body: reply.body,
      metadata: { conversation_id: conversation.id },
    });

    const audit = await database!.sql<{ target_id: string }[]>`
      SELECT target_id FROM app.audit_logs
      WHERE school_id = ${world.schoolId} AND target_table = 'messages'
    `;
    expect(audit.map((row) => row.target_id).sort()).toEqual(
      [first.id, second.id, reply.id].sort(),
    );
  });

  test("a recipient who disabled DIRECT_MESSAGE in-app gets no notification", async () => {
    const world = await buildWorld();
    const conversation = await openConversation(world);
    await database!.sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE studafy_admin");
      await tx`SELECT set_config('app.school_id', ${world.schoolId}, true)`;
      await tx`
        INSERT INTO app.notification_preferences (school_id, user_id, notification_type, channel, enabled)
        VALUES (${world.schoolId}, ${world.teacher.userId}, 'DIRECT_MESSAGE', 'in_app', false)
        ON CONFLICT (user_id, notification_type, channel) DO UPDATE SET enabled = false
      `;
    });

    await send(world.parent, conversation.id, "Quick question");
    const [row] = await database!.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM app.notifications
      WHERE school_id = ${world.schoolId} AND user_id = ${world.teacher.userId}
        AND notification_type = 'DIRECT_MESSAGE'
    `;
    expect(row!.count).toBe(0);
  });

  test("message history pages with before, polls with since, and orders oldest first", async () => {
    const world = await buildWorld();
    const conversation = await openConversation(world);
    const sent: MessageBody[] = [];
    for (let i = 1; i <= 5; i += 1) {
      sent.push(await send(i % 2 ? world.parent : world.teacher, conversation.id, `message ${i}`));
    }

    const latest = await messages(world.teacher, conversation.id, "?limit=2");
    expect(latest.messages.map((m) => m.body)).toEqual(["message 4", "message 5"]);
    expect(latest.has_more).toBe(true);

    const older = await messages(world.teacher, conversation.id, `?limit=2&before=${sent[3]!.id}`);
    expect(older.messages.map((m) => m.body)).toEqual(["message 2", "message 3"]);
    expect(older.has_more).toBe(true);

    const oldest = await messages(world.teacher, conversation.id, `?limit=2&before=${sent[1]!.id}`);
    expect(oldest.messages.map((m) => m.body)).toEqual(["message 1"]);
    expect(oldest.has_more).toBe(false);

    const all = await messages(world.parent, conversation.id);
    expect(all.messages.map((m) => m.id)).toEqual(sent.map((m) => m.id));
    expect(all.has_more).toBe(false);

    // Polling with the newest timestamp a client holds returns nothing new — the echo of a
    // message's own created_at must not re-deliver it.
    const caughtUp = await messages(
      world.parent,
      conversation.id,
      `?since=${encodeURIComponent(sent[4]!.created_at)}`,
    );
    expect(caughtUp).toEqual({ messages: [], has_more: false });

    const newer = await messages(
      world.parent,
      conversation.id,
      `?limit=2&since=${encodeURIComponent(sent[1]!.created_at)}`,
    );
    expect(newer.messages.map((m) => m.body)).toEqual(["message 3", "message 4"]);
    expect(newer.has_more).toBe(true);

    expect(
      (
        await request(
          world.parent,
          "GET",
          `/api/messaging/conversations/${conversation.id}/messages?before=${sent[1]!.id}&since=${encodeURIComponent(sent[0]!.created_at)}`,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await request(
          world.parent,
          "GET",
          `/api/messaging/conversations/${conversation.id}/messages?limit=101`,
        )
      ).status,
    ).toBe(400);
  });

  test("message bodies are validated", async () => {
    const world = await buildWorld();
    const conversation = await openConversation(world);
    const path = `/api/messaging/conversations/${conversation.id}/messages`;

    expect((await request(world.parent, "POST", path, { body: "   " })).status).toBe(400);
    expect((await request(world.parent, "POST", path, { body: "x".repeat(2001) })).status).toBe(
      400,
    );
    expect((await request(world.parent, "POST", path, { body: "x".repeat(2000) })).status).toBe(
      201,
    );
  });

  test("non-participants get 404 everywhere and see no conversations", async () => {
    const world = await buildWorld();
    const conversation = await openConversation(world);
    await send(world.parent, conversation.id, "Private");
    const base = `/api/messaging/conversations/${conversation.id}`;

    for (const outsider of [world.otherParent, world.otherTeacher]) {
      expect((await request(outsider, "GET", base)).status).toBe(404);
      expect((await request(outsider, "GET", `${base}/messages`)).status).toBe(404);
      expect((await request(outsider, "POST", `${base}/messages`, { body: "hi" })).status).toBe(
        404,
      );
      expect((await request(outsider, "POST", `${base}/read`)).status).toBe(404);
      const inbox = (await (
        await request(outsider, "GET", "/api/messaging/conversations")
      ).json()) as { conversations: unknown[] };
      expect(inbox.conversations).toEqual([]);
    }

    // A school admin holds the permissions but is not a participant either.
    const admin: Actor = {
      schoolId: world.schoolId,
      userId: (
        await database!.sql<{ id: string }[]>`
        SELECT user_id AS id FROM app.user_roles
        WHERE school_id = ${world.schoolId} AND role = 'ORG_ADMIN' LIMIT 1
      `
      )[0]!.id,
      roles: [ROLES.ORG_ADMIN],
    };
    expect((await request(admin, "GET", base)).status).toBe(404);
  });

  test("RLS limits threads and messages to participants and enforces the opening rule", async () => {
    const world = await buildWorld();
    const conversation = await openConversation(world);
    await send(world.parent, conversation.id, "Visible only to us");

    const asUser = async <T>(
      userId: string,
      fn: (tx: TransactionSql) => Promise<T>,
    ): Promise<T> => {
      let result: T | undefined;
      await database!.sql.begin(async (tx) => {
        await tx`SELECT set_config('app.school_id', ${world.schoolId}, true)`;
        await tx`SELECT set_config('app.user_id', ${userId}, true)`;
        await tx.unsafe("SET LOCAL ROLE studafy_app");
        result = await fn(tx);
      });
      return result as T;
    };

    const counts = async (userId: string) =>
      asUser(userId, async (tx) => {
        const [row] = await tx<{ conversations: number; messages: number }[]>`
          SELECT
            (SELECT count(*)::int FROM app.message_conversations) AS conversations,
            (SELECT count(*)::int FROM app.messages) AS messages
        `;
        return row!;
      });

    expect(await counts(world.teacher.userId)).toEqual({ conversations: 1, messages: 1 });
    expect(await counts(world.otherParent.userId)).toEqual({ conversations: 0, messages: 0 });
    expect(await counts(world.otherTeacher.userId)).toEqual({ conversations: 0, messages: 0 });

    // The parent cannot bypass the API to open a thread with a teacher who does not teach the child.
    let refused = false;
    try {
      await asUser(
        world.parent.userId,
        (tx) => tx`
        INSERT INTO app.message_conversations (school_id, parent_user_id, teacher_user_id, student_id)
        VALUES (${world.schoolId}, ${world.parent.userId}, ${world.otherTeacher.userId}, ${world.studentId})
      `,
      );
    } catch (error) {
      refused = /row-level security/.test(String(error));
    }
    expect(refused).toBe(true);

    // A teacher may open a thread as themselves with a linked parent of a child they teach...
    const mother = await createUser(database!.sql, world.schoolId, {
      email: `rls-mother-${crypto.randomUUID().slice(0, 8)}@test.local`,
    });
    await assignRole(database!.sql, world.schoolId, mother.id, ROLES.PARENT);
    await linkParent(world.schoolId, mother.id, world.studentId, "mother");
    const insertAs = async (
      userId: string,
      row: { parent: string; teacher: string; student: string },
    ): Promise<boolean> => {
      try {
        await asUser(
          userId,
          (tx) => tx`
          INSERT INTO app.message_conversations (school_id, parent_user_id, teacher_user_id, student_id)
          VALUES (${world.schoolId}, ${row.parent}, ${row.teacher}, ${row.student})
        `,
        );
        return true;
      } catch (error) {
        if (/row-level security/.test(String(error))) return false;
        throw error;
      }
    };
    // (Nobody else may open that thread on the teacher's behalf.)
    expect(
      await insertAs(world.otherTeacher.userId, {
        parent: mother.id,
        teacher: world.teacher.userId,
        student: world.studentId,
      }),
    ).toBe(false);
    expect(
      await insertAs(world.teacher.userId, {
        parent: mother.id,
        teacher: world.teacher.userId,
        student: world.studentId,
      }),
    ).toBe(true);
    // ...but not about a child they do not teach.
    expect(
      await insertAs(world.otherTeacher.userId, {
        parent: world.parent.userId,
        teacher: world.otherTeacher.userId,
        student: world.studentId,
      }),
    ).toBe(false);
    // Nor with a parent who is not linked to the child.
    expect(
      await insertAs(world.teacher.userId, {
        parent: world.otherParent.userId,
        teacher: world.teacher.userId,
        student: world.studentId,
      }),
    ).toBe(false);

    // Nor can a participant post as the other participant.
    let impersonationRefused = false;
    try {
      await asUser(
        world.parent.userId,
        (tx) => tx`
        INSERT INTO app.messages (school_id, conversation_id, sender_user_id, body)
        VALUES (${world.schoolId}, ${conversation.id}, ${world.teacher.userId}, 'spoofed')
      `,
      );
    } catch (error) {
      impersonationRefused = /row-level security/.test(String(error));
    }
    expect(impersonationRefused).toBe(true);
  });

  test("machine (api-channel) tokens are refused", async () => {
    const world = await buildWorld();
    const res = await request(
      { ...world.parent, channel: "api" },
      "GET",
      "/api/messaging/conversations",
    );
    expect(res.status).toBe(403);
  });
});
