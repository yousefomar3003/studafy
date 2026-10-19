/**
 * Parent <-> teacher 1-to-1 messaging (app.message_conversations / app.messages, migration 000127).
 *
 * Either participant may open a thread (teacher-initiated since 000130): a parent with a teacher of
 * a linked child, or a teacher with a linked parent of a child they teach.
 *
 * Every function runs inside the caller's tenant transaction (withTenantTx), so RLS is armed: the
 * database already limits threads and messages to their two participants and refuses a thread the
 * messaging rule does not allow. The service states the same rules explicitly so that it can answer
 * with the right status — 404 for a thread or child the caller has no relationship to (never
 * revealing that it exists), 403 for a teacher who does not teach the child — rather than letting a
 * policy violation surface as a 500.
 */

import { ERROR_CODES, NOTIFICATION_TYPES } from "@studafy/constants";
import {
  isTemplateLocale,
  NOTIFICATION_CHANNELS,
  renderNotification,
} from "@studafy/notification-templates";

import { CodedHttpException } from "../../coded-http-exception";
import { buildPermanentKey, promoteTempObject, requireStorage } from "../../lib/storage";
import { emitAuditLog } from "../../middleware/auditEmitter";
import { getContentClass } from "../storage/content-classes";
import { DOWNLOAD_PRESIGN_TTL_SECONDS } from "../storage/download-service";
import { assertStorageUploadQuota, recordStorageUpload } from "../storage/quota-service";
import { inspectStagedUpload } from "../storage/service";

import { MESSAGE_ATTACHMENT_CONTENT_CLASS } from "./schemas";

import type {
  BlockState,
  Conversation,
  Message,
  MessageAttachment,
  MessageAttachmentContentType,
  MessageListQuery,
  MessagingContactList,
  ParentRelationship,
  ParticipantProfile,
  SendMessageInput,
  TeacherMessagingContactList,
} from "./schemas";
import type { StorageService } from "../../lib/storage";
import type { InspectedStagedUpload } from "../storage/service";
import type { TransactionSql } from "postgres";

/** The authenticated caller, as the service needs it. */
export interface MessagingActor {
  schoolId: string;
  userId: string;
}

/** A defensive bound on the inbox: the contract has no pagination, so it must never be unbounded. */
const MAX_CONVERSATIONS = 200;

/** Longest message excerpt carried in the recipient's notification body. */
const NOTIFICATION_PREVIEW_LENGTH = 140;

/** Notification preview for a message with images and no text, by recipient locale. */
const PHOTO_PREVIEW_EN = "📷 Photo";
const PHOTO_PREVIEW_AR = "📷 صورة";

function notFound(what: string): CodedHttpException {
  return new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, `${what} not found`);
}

function blocked(): CodedHttpException {
  return new CodedHttpException(
    403,
    ERROR_CODES.MESSAGING_BLOCKED,
    "Messaging is blocked between you and this person",
  );
}

/** True when a block stands between the two users in either direction (app.message_block_between). */
export async function isBlockedBetween(
  tx: TransactionSql,
  userA: string,
  userB: string,
): Promise<boolean> {
  const [row] = await tx<{ blocked: boolean }[]>`
    SELECT app.message_block_between(${userA}::uuid, ${userB}::uuid) AS blocked
  `;
  return row?.blocked === true;
}

// ---------------------------------------------------------------------------
// Relationship checks
// ---------------------------------------------------------------------------

/** 404 unless `studentId` is linked to the calling parent. */
async function assertLinkedChild(
  tx: TransactionSql,
  actor: MessagingActor,
  studentId: string,
): Promise<void> {
  const [link] = await tx<{ one: number }[]>`
    SELECT 1 AS one
    FROM app.parent_child_links
    WHERE school_id = ${actor.schoolId}::uuid
      AND parent_user_id = ${actor.userId}::uuid
      AND student_id = ${studentId}::uuid
  `;
  if (!link) throw notFound("Student");
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

interface ContactRow {
  teacher_user_id: string;
  name: string;
  class_id: string;
  class_code: string;
  course_name: string | null;
  conversation_id: string | null;
}

/**
 * The teachers a parent may message about one linked child, each with the child's classes they
 * teach. Candidates are the lead teachers and live-timetable slot teachers of the child's current
 * classes; app.can_message_teacher_about_student — the same function the INSERT policy calls — has
 * the final say, so this list can never offer a teacher a thread would then be refused for.
 */
export async function listContacts(
  tx: TransactionSql,
  actor: MessagingActor,
  studentId: string,
): Promise<MessagingContactList> {
  await assertLinkedChild(tx, actor, studentId);

  const rows = await tx<ContactRow[]>`
    WITH child_classes AS (
      SELECT c.id, c.code, c.lead_teacher_id, co.name AS course_name
      FROM app.enrollments AS e
      JOIN app.classes AS c ON c.id = e.class_id AND c.school_id = e.school_id
      LEFT JOIN app.courses AS co ON co.id = c.course_id AND co.school_id = c.school_id
      WHERE e.school_id = ${actor.schoolId}::uuid
        AND e.student_id = ${studentId}::uuid
        AND e.status = 'active'
        AND c.status IN ('planned', 'active')
    ),
    class_teachers AS (
      SELECT cc.id AS class_id, cc.lead_teacher_id AS teacher_id
      FROM child_classes AS cc
      UNION
      SELECT ts.class_id, ts.teacher_id
      FROM app.timetable_slots AS ts
      JOIN app.timetable_versions AS tv
        ON tv.id = ts.timetable_version_id AND tv.school_id = ts.school_id
      WHERE ts.school_id = ${actor.schoolId}::uuid
        AND ts.class_id IN (SELECT id FROM child_classes)
        AND tv.status = 'approved'
    )
    SELECT
      u.id AS teacher_user_id,
      coalesce(u.display_name, u.email) AS name,
      cc.id AS class_id,
      cc.code AS class_code,
      cc.course_name,
      mc.id AS conversation_id
    FROM class_teachers AS ct
    JOIN child_classes AS cc ON cc.id = ct.class_id
    JOIN app.teachers AS t ON t.id = ct.teacher_id AND t.school_id = ${actor.schoolId}::uuid
    JOIN app.users AS u ON u.id = t.user_id AND u.school_id = t.school_id
    LEFT JOIN app.message_conversations AS mc
      ON mc.school_id = u.school_id
     AND mc.parent_user_id = ${actor.userId}::uuid
     AND mc.teacher_user_id = u.id
     AND mc.student_id = ${studentId}::uuid
    WHERE u.id <> ${actor.userId}::uuid
      AND app.can_message_teacher_about_student(${actor.userId}::uuid, u.id, ${studentId}::uuid)
    ORDER BY name, u.id, cc.code
  `;

  const byTeacher = new Map<string, MessagingContactList["contacts"][number]>();
  for (const row of rows) {
    let contact = byTeacher.get(row.teacher_user_id);
    if (!contact) {
      contact = {
        teacher_id: row.teacher_user_id,
        name: row.name,
        classes: [],
        conversation_id: row.conversation_id,
      };
      byTeacher.set(row.teacher_user_id, contact);
    }
    contact.classes.push({ id: row.class_id, code: row.class_code, course_name: row.course_name });
  }
  return { contacts: [...byTeacher.values()] };
}

interface TeacherContactRow {
  student_id: string;
  student_name: string;
  class_id: string;
  class_code: string;
  course_name: string | null;
  parent_user_id: string;
  parent_name: string;
  relationship: ParentRelationship;
  conversation_id: string | null;
}

/**
 * The parents a teacher may message: every student currently enrolled in a class the caller
 * teaches (lead teacher, or a slot in an approved timetable) who has a linked parent, each with
 * the caller's classes they are in and those parents. As with [listContacts], the candidates are
 * filtered through app.can_message_teacher_about_student — the INSERT policy's own rule — once per
 * (student, parent) pair, so a parent offered here is never refused on open.
 */
export async function listTeacherContacts(
  tx: TransactionSql,
  actor: MessagingActor,
): Promise<TeacherMessagingContactList> {
  const rows = await tx<TeacherContactRow[]>`
    WITH taught_classes AS (
      SELECT c.id, c.code, co.name AS course_name
      FROM app.classes AS c
      JOIN app.teachers AS t ON t.school_id = c.school_id AND t.user_id = ${actor.userId}::uuid
      LEFT JOIN app.courses AS co ON co.id = c.course_id AND co.school_id = c.school_id
      WHERE c.school_id = ${actor.schoolId}::uuid
        AND c.status IN ('planned', 'active')
        AND (
          c.lead_teacher_id = t.id
          OR EXISTS (
            SELECT 1
            FROM app.timetable_slots AS ts
            JOIN app.timetable_versions AS tv
              ON tv.id = ts.timetable_version_id AND tv.school_id = ts.school_id
            WHERE ts.school_id = c.school_id
              AND ts.class_id = c.id
              AND ts.teacher_id = t.id
              AND tv.status = 'approved'
          )
        )
    ),
    taught_students AS (
      SELECT e.student_id, tc.id AS class_id, tc.code AS class_code, tc.course_name
      FROM app.enrollments AS e
      JOIN taught_classes AS tc ON tc.id = e.class_id
      WHERE e.school_id = ${actor.schoolId}::uuid
        AND e.status = 'active'
    ),
    pairs AS (
      SELECT DISTINCT pcl.student_id, pcl.parent_user_id, pcl.relationship
      FROM app.parent_child_links AS pcl
      WHERE pcl.school_id = ${actor.schoolId}::uuid
        AND pcl.student_id IN (SELECT student_id FROM taught_students)
        AND pcl.parent_user_id <> ${actor.userId}::uuid
    ),
    allowed AS (
      SELECT p.student_id, p.parent_user_id, p.relationship
      FROM pairs AS p
      WHERE app.can_message_teacher_about_student(
        p.parent_user_id, ${actor.userId}::uuid, p.student_id
      )
    )
    SELECT
      a.student_id,
      coalesce(s.preferred_name, s.first_name) || ' ' || s.last_name AS student_name,
      ts.class_id,
      ts.class_code,
      ts.course_name,
      a.parent_user_id,
      coalesce(pu.display_name, pu.email) AS parent_name,
      a.relationship::text AS relationship,
      mc.id AS conversation_id
    FROM allowed AS a
    JOIN app.students AS s ON s.id = a.student_id AND s.school_id = ${actor.schoolId}::uuid
    JOIN taught_students AS ts ON ts.student_id = a.student_id
    JOIN app.users AS pu ON pu.id = a.parent_user_id AND pu.school_id = ${actor.schoolId}::uuid
    LEFT JOIN app.message_conversations AS mc
      ON mc.school_id = pu.school_id
     AND mc.parent_user_id = a.parent_user_id
     AND mc.teacher_user_id = ${actor.userId}::uuid
     AND mc.student_id = a.student_id
    ORDER BY student_name, a.student_id, ts.class_code, ts.class_id, parent_name, a.parent_user_id
  `;

  type StudentContact = TeacherMessagingContactList["students"][number];
  const byStudent = new Map<
    string,
    { contact: StudentContact; classIds: Set<string>; parentIds: Set<string> }
  >();
  for (const row of rows) {
    let entry = byStudent.get(row.student_id);
    if (!entry) {
      entry = {
        contact: { id: row.student_id, name: row.student_name, classes: [], parents: [] },
        classIds: new Set(),
        parentIds: new Set(),
      };
      byStudent.set(row.student_id, entry);
    }
    if (!entry.classIds.has(row.class_id)) {
      entry.classIds.add(row.class_id);
      entry.contact.classes.push({
        id: row.class_id,
        code: row.class_code,
        course_name: row.course_name,
      });
    }
    if (!entry.parentIds.has(row.parent_user_id)) {
      entry.parentIds.add(row.parent_user_id);
      entry.contact.parents.push({
        parent_id: row.parent_user_id,
        name: row.parent_name,
        relationship: row.relationship,
        conversation_id: row.conversation_id,
      });
    }
  }
  // Every (class, parent) combination of a student is a row, ordered class code then parent name,
  // so first occurrences already keep both lists in that order.
  return { students: [...byStudent.values()].map(({ contact }) => contact) };
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

interface ConversationRow {
  id: string;
  student_id: string;
  parent_user_id: string;
  parent_name: string;
  teacher_user_id: string;
  teacher_name: string;
  last_message_at: Date;
  last_body: string | null;
  last_sender_id: string | null;
  last_created_at: Date | null;
  last_attachment_count: number | null;
  unread_count: number;
  blocked_by_me: boolean;
  has_blocked_me: boolean;
}

/**
 * The caller's threads (optionally one, optionally about one child), newest activity first.
 * The participant predicate is stated explicitly although RLS enforces it too, so the query reads
 * as what it means and keeps using the per-side inbox indexes.
 */
async function selectConversations(
  tx: TransactionSql,
  actor: MessagingActor,
  filter: { conversationId?: string; studentId?: string },
): Promise<Conversation[]> {
  const rows = await tx<ConversationRow[]>`
    SELECT
      mc.id,
      mc.student_id,
      mc.parent_user_id,
      coalesce(pu.display_name, pu.email) AS parent_name,
      mc.teacher_user_id,
      coalesce(tu.display_name, tu.email) AS teacher_name,
      mc.last_message_at,
      lm.body AS last_body,
      lm.sender_user_id AS last_sender_id,
      lm.created_at AS last_created_at,
      lm.attachment_count AS last_attachment_count,
      EXISTS (
        SELECT 1
        FROM app.message_blocks AS mb
        WHERE mb.school_id = mc.school_id
          AND mb.blocker_user_id = ${actor.userId}::uuid
          AND mb.blocked_user_id = CASE WHEN mc.parent_user_id = ${actor.userId}::uuid
            THEN mc.teacher_user_id ELSE mc.parent_user_id END
      ) AS blocked_by_me,
      app.message_user_has_blocked_me(
        CASE WHEN mc.parent_user_id = ${actor.userId}::uuid
          THEN mc.teacher_user_id ELSE mc.parent_user_id END
      ) AS has_blocked_me,
      (
        SELECT count(*)::int
        FROM app.messages AS m
        WHERE m.school_id = mc.school_id
          AND m.conversation_id = mc.id
          AND m.sender_user_id <> ${actor.userId}::uuid
          AND m.created_at > coalesce(
            CASE WHEN mc.parent_user_id = ${actor.userId}::uuid
              THEN mc.parent_last_read_at ELSE mc.teacher_last_read_at END,
            '-infinity'::timestamptz
          )
      ) AS unread_count
    FROM app.message_conversations AS mc
    JOIN app.users AS pu ON pu.id = mc.parent_user_id AND pu.school_id = mc.school_id
    JOIN app.users AS tu ON tu.id = mc.teacher_user_id AND tu.school_id = mc.school_id
    LEFT JOIN LATERAL (
      SELECT
        m.body,
        m.sender_user_id,
        m.created_at,
        (
          SELECT count(*)::int
          FROM app.message_attachments AS ma
          WHERE ma.school_id = m.school_id AND ma.message_id = m.id
        ) AS attachment_count
      FROM app.messages AS m
      WHERE m.school_id = mc.school_id AND m.conversation_id = mc.id
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT 1
    ) AS lm ON true
    WHERE mc.school_id = ${actor.schoolId}::uuid
      AND (mc.parent_user_id = ${actor.userId}::uuid OR mc.teacher_user_id = ${actor.userId}::uuid)
      AND (${filter.conversationId ?? null}::uuid IS NULL OR mc.id = ${filter.conversationId ?? null}::uuid)
      AND (${filter.studentId ?? null}::uuid IS NULL OR mc.student_id = ${filter.studentId ?? null}::uuid)
    ORDER BY mc.last_message_at DESC, mc.id DESC
    LIMIT ${MAX_CONVERSATIONS}
  `;
  if (rows.length === 0) return [];

  // A teacher's own read of app.students is scoped to the children they currently teach; the
  // SECURITY DEFINER lookup keeps a thread's subject named after the child changes class.
  const studentIds = [...new Set(rows.map((row) => row.student_id))];
  const names = await tx<{ student_id: string; display_name: string }[]>`
    SELECT student_id, display_name
    FROM app.message_conversation_student_names(${studentIds}::uuid[])
  `;
  const nameById = new Map(names.map((row) => [row.student_id, row.display_name]));

  return rows.map((row) => ({
    id: row.id,
    student: { id: row.student_id, name: nameById.get(row.student_id) ?? "" },
    parent: { id: row.parent_user_id, name: row.parent_name },
    teacher: { id: row.teacher_user_id, name: row.teacher_name },
    last_message:
      row.last_body !== null && row.last_sender_id !== null && row.last_created_at !== null
        ? {
            body: row.last_body,
            attachment_count: row.last_attachment_count ?? 0,
            sender_id: row.last_sender_id,
            created_at: row.last_created_at.toISOString(),
          }
        : null,
    unread_count: row.unread_count,
    updated_at: row.last_message_at.toISOString(),
    blocked_by_me: row.blocked_by_me,
    has_blocked_me: row.has_blocked_me,
  }));
}

export function listConversations(
  tx: TransactionSql,
  actor: MessagingActor,
  studentId?: string,
): Promise<Conversation[]> {
  return selectConversations(tx, actor, { studentId });
}

export async function getConversation(
  tx: TransactionSql,
  actor: MessagingActor,
  conversationId: string,
): Promise<Conversation> {
  const [conversation] = await selectConversations(tx, actor, { conversationId });
  if (!conversation) throw notFound("Conversation");
  return conversation;
}

/**
 * Inserts the (school, parent, teacher, child) thread, or finds the one that already exists —
 * whichever participant opened it first. Concurrent opens of the same thread converge on one row
 * through uq_message_conversations_participants. The caller has already applied the messaging
 * rule; the INSERT policy applies it again.
 */
async function insertOrGetConversation(
  tx: TransactionSql,
  actor: MessagingActor,
  thread: { parentUserId: string; teacherUserId: string; studentId: string },
): Promise<{ conversation: Conversation; created: boolean }> {
  const inserted = await tx<{ id: string }[]>`
    INSERT INTO app.message_conversations (school_id, parent_user_id, teacher_user_id, student_id)
    VALUES (
      ${actor.schoolId}::uuid,
      ${thread.parentUserId}::uuid,
      ${thread.teacherUserId}::uuid,
      ${thread.studentId}::uuid
    )
    ON CONFLICT (school_id, parent_user_id, teacher_user_id, student_id) DO NOTHING
    RETURNING id
  `;

  let conversationId: string;
  const created = inserted[0] !== undefined;
  if (inserted[0]) {
    conversationId = inserted[0].id;
    await emitAuditLog(tx, {
      action: "insert",
      targetTable: "message_conversations",
      targetId: conversationId,
      newValues: {
        parent_user_id: thread.parentUserId,
        teacher_user_id: thread.teacherUserId,
        student_id: thread.studentId,
      },
    });
  } else {
    const [existing] = await tx<{ id: string }[]>`
      SELECT id
      FROM app.message_conversations
      WHERE school_id = ${actor.schoolId}::uuid
        AND parent_user_id = ${thread.parentUserId}::uuid
        AND teacher_user_id = ${thread.teacherUserId}::uuid
        AND student_id = ${thread.studentId}::uuid
    `;
    if (!existing) throw notFound("Conversation");
    conversationId = existing.id;
  }

  return { conversation: await getConversation(tx, actor, conversationId), created };
}

/** The messaging rule (app.can_message_teacher_about_student), as the API asks it before inserting. */
async function canMessage(
  tx: TransactionSql,
  thread: { parentUserId: string; teacherUserId: string; studentId: string },
): Promise<boolean> {
  if (thread.parentUserId === thread.teacherUserId) return false;
  const [row] = await tx<{ allowed: boolean }[]>`
    SELECT app.can_message_teacher_about_student(
      ${thread.parentUserId}::uuid, ${thread.teacherUserId}::uuid, ${thread.studentId}::uuid
    ) AS allowed
  `;
  return row?.allowed === true;
}

/**
 * Opens the parent's thread with a teacher about a child, or returns the one that already exists.
 * `created` tells the route whether to answer 201 or 200.
 */
export async function getOrCreateConversation(
  tx: TransactionSql,
  actor: MessagingActor,
  input: { studentId: string; teacherUserId: string },
): Promise<{ conversation: Conversation; created: boolean }> {
  await assertLinkedChild(tx, actor, input.studentId);

  const thread = {
    parentUserId: actor.userId,
    teacherUserId: input.teacherUserId,
    studentId: input.studentId,
  };
  if (!(await canMessage(tx, thread))) {
    throw new CodedHttpException(
      403,
      ERROR_CODES.AUTHZ_FORBIDDEN,
      "You can only message a teacher who teaches this child",
    );
  }
  if (await isBlockedBetween(tx, thread.parentUserId, thread.teacherUserId)) throw blocked();
  return insertOrGetConversation(tx, actor, thread);
}

/**
 * Opens the teacher's thread with a parent about a student the teacher teaches, or returns the one
 * that already exists — including one the parent started. `created` as above. 403 unless the
 * caller teaches the student and the parent is linked to them (one answer for both, so the
 * endpoint does not reveal which students or links exist).
 */
export async function getOrCreateTeacherConversation(
  tx: TransactionSql,
  actor: MessagingActor,
  input: { studentId: string; parentUserId: string },
): Promise<{ conversation: Conversation; created: boolean }> {
  const thread = {
    parentUserId: input.parentUserId,
    teacherUserId: actor.userId,
    studentId: input.studentId,
  };
  if (!(await canMessage(tx, thread))) {
    throw new CodedHttpException(
      403,
      ERROR_CODES.AUTHZ_FORBIDDEN,
      "You can only message a parent of a student you teach",
    );
  }
  if (await isBlockedBetween(tx, thread.parentUserId, thread.teacherUserId)) throw blocked();
  return insertOrGetConversation(tx, actor, thread);
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

interface MessageRow {
  id: string;
  conversation_id: string;
  sender_user_id: string;
  body: string;
  created_at: Date;
}

interface AttachmentRow {
  id: string;
  message_id: string;
  storage_key: string;
  mime_type: MessageAttachmentContentType;
  /** bigint, which postgres.js hands back as a string. */
  size_bytes: string;
}

/**
 * Project a stored image onto its response shape, with a short-lived pre-signed GET. The storage
 * key is never serialized. Without object storage the row still renders with a null URL, the same
 * posture as assignment attachments: history stays readable on a deployment without storage.
 */
export async function toAttachmentResponse(
  storage: StorageService | null,
  row: {
    id: string;
    storage_key: string;
    mime_type: MessageAttachmentContentType;
    size_bytes: string | number;
  },
): Promise<MessageAttachment> {
  const presigned = storage
    ? await storage.presign(row.storage_key, "GET", undefined, DOWNLOAD_PRESIGN_TTL_SECONDS)
    : null;
  return {
    id: row.id,
    content_type: row.mime_type,
    size_bytes: Number(row.size_bytes),
    download_url: presigned?.url ?? null,
    download_url_expires_at: presigned?.expiresAt.toISOString() ?? null,
  };
}

/** The images on a page of messages, by message id, in display order — one query per page. */
async function loadAttachments(
  tx: TransactionSql,
  storage: StorageService | null,
  actor: MessagingActor,
  messageIds: readonly string[],
): Promise<Map<string, MessageAttachment[]>> {
  const byMessage = new Map<string, MessageAttachment[]>();
  if (messageIds.length === 0) return byMessage;
  const rows = await tx<AttachmentRow[]>`
    SELECT id, message_id, storage_key, mime_type, size_bytes::text AS size_bytes
    FROM app.message_attachments
    WHERE school_id = ${actor.schoolId}::uuid
      AND message_id = ANY(${messageIds as string[]}::uuid[])
    ORDER BY message_id, position
  `;
  for (const row of rows) {
    const list = byMessage.get(row.message_id) ?? [];
    list.push(await toAttachmentResponse(storage, row));
    byMessage.set(row.message_id, list);
  }
  return byMessage;
}

function toMessage(row: MessageRow, attachments: MessageAttachment[] = []): Message {
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    sender_id: row.sender_user_id,
    body: row.body,
    attachments,
    created_at: row.created_at.toISOString(),
  };
}

async function toMessages(
  tx: TransactionSql,
  storage: StorageService | null,
  actor: MessagingActor,
  rows: readonly MessageRow[],
): Promise<Message[]> {
  const attachments = await loadAttachments(
    tx,
    storage,
    actor,
    rows.map((row) => row.id),
  );
  return rows.map((row) => toMessage(row, attachments.get(row.id)));
}

interface ParticipantRow {
  id: string;
  parent_user_id: string;
  teacher_user_id: string;
  student_id: string;
}

/** The thread's participants, or 404 when the caller is not one of them. */
export async function loadParticipants(
  tx: TransactionSql,
  actor: MessagingActor,
  conversationId: string,
): Promise<ParticipantRow> {
  const [row] = await tx<ParticipantRow[]>`
    SELECT id, parent_user_id, teacher_user_id, student_id
    FROM app.message_conversations
    WHERE school_id = ${actor.schoolId}::uuid
      AND id = ${conversationId}::uuid
      AND (parent_user_id = ${actor.userId}::uuid OR teacher_user_id = ${actor.userId}::uuid)
  `;
  if (!row) throw notFound("Conversation");
  return row;
}

/** The participant on the other side of the thread from the caller. */
export function otherParticipant(
  participants: ParticipantRow,
  actor: MessagingActor,
): { userId: string; role: "parent" | "teacher" } {
  return participants.parent_user_id === actor.userId
    ? { userId: participants.teacher_user_id, role: "teacher" }
    : { userId: participants.parent_user_id, role: "parent" };
}

/**
 * One page of a thread, oldest first.
 *
 * - default: the newest `limit` messages; `has_more` = older ones exist.
 * - `before`: the `limit` messages immediately older than that message; `has_more` = still older.
 * - `since`: the oldest `limit` messages strictly newer than the timestamp (the polling path);
 *   `has_more` = more newer ones exist past this page.
 *
 * Each message carries its images with fresh pre-signed URLs (null without object storage).
 */
export async function listMessages(
  tx: TransactionSql,
  storage: StorageService | null,
  actor: MessagingActor,
  conversationId: string,
  query: MessageListQuery,
): Promise<{ messages: Message[]; has_more: boolean }> {
  await loadParticipants(tx, actor, conversationId);
  const fetch = query.limit + 1;

  if (query.since !== undefined) {
    const rows = await tx<MessageRow[]>`
      SELECT id, conversation_id, sender_user_id, body, created_at
      FROM app.messages
      WHERE school_id = ${actor.schoolId}::uuid
        AND conversation_id = ${conversationId}::uuid
        AND created_at > ${query.since}::timestamptz
      ORDER BY created_at ASC, id ASC
      LIMIT ${fetch}
    `;
    return {
      messages: await toMessages(tx, storage, actor, rows.slice(0, query.limit)),
      has_more: rows.length > query.limit,
    };
  }

  let rows: MessageRow[];
  if (query.before !== undefined) {
    const [cursor] = await tx<{ created_at: Date; id: string }[]>`
      SELECT created_at, id
      FROM app.messages
      WHERE school_id = ${actor.schoolId}::uuid
        AND conversation_id = ${conversationId}::uuid
        AND id = ${query.before}::uuid
    `;
    if (!cursor) throw notFound("Message");
    rows = await tx<MessageRow[]>`
      SELECT id, conversation_id, sender_user_id, body, created_at
      FROM app.messages
      WHERE school_id = ${actor.schoolId}::uuid
        AND conversation_id = ${conversationId}::uuid
        AND (created_at, id) < (${cursor.created_at}::timestamptz, ${cursor.id}::uuid)
      ORDER BY created_at DESC, id DESC
      LIMIT ${fetch}
    `;
  } else {
    rows = await tx<MessageRow[]>`
      SELECT id, conversation_id, sender_user_id, body, created_at
      FROM app.messages
      WHERE school_id = ${actor.schoolId}::uuid
        AND conversation_id = ${conversationId}::uuid
      ORDER BY created_at DESC, id DESC
      LIMIT ${fetch}
    `;
  }

  return {
    messages: await toMessages(tx, storage, actor, rows.slice(0, query.limit).reverse()),
    has_more: rows.length > query.limit,
  };
}

function previewOf(body: string): string {
  if (body.length <= NOTIFICATION_PREVIEW_LENGTH) return body;
  return `${body.slice(0, NOTIFICATION_PREVIEW_LENGTH - 1).trimEnd()}…`;
}

/**
 * Every staged image passes the `message.attachment` content-class checks against the stored
 * object (type, size, optional checksum) and the school's storage quota before anything is
 * promoted, so one bad file refuses the send and leaves every staged upload in place for a retry.
 */
async function inspectAttachments(
  tx: TransactionSql,
  storage: StorageService,
  actor: MessagingActor,
  attachments: NonNullable<SendMessageInput["attachments"]>,
): Promise<(InspectedStagedUpload & { tempKey: string })[]> {
  const contentClass = getContentClass(MESSAGE_ATTACHMENT_CONTENT_CLASS);
  const inspected: (InspectedStagedUpload & { tempKey: string })[] = [];
  for (const attachment of attachments) {
    const upload = await inspectStagedUpload(storage, actor.schoolId, contentClass, {
      storageKey: attachment.storage_key,
      checksumSha256: attachment.checksum_sha256,
    });
    inspected.push({ ...upload, tempKey: attachment.storage_key });
  }
  await assertStorageUploadQuota(
    tx,
    inspected.reduce((total, upload) => total + upload.sizeBytes, 0),
  );
  return inspected;
}

/**
 * Appends a message, with up to four images, advances the thread's activity and the sender's own
 * read marker (they have read what they just wrote), and leaves the other participant one in-app
 * DIRECT_MESSAGE notification unless they have turned that type off. All in the caller's
 * transaction, so the message, its images, its notification and its audit row commit together.
 *
 * Images: each staged temp/ key is inspected (inspectAttachments), the message row is written —
 * which is where RLS refuses a blocked pair — and only then are the objects promoted to permanent/
 * and their rows inserted. A failure after a promotion leaves an unreferenced permanent object
 * (wasted bytes, reclaimed by the storage reconciliation), never a row pointing at a missing one.
 * Without object storage a text-only send still works; a send with images answers 503.
 *
 * Push delivery is not triggered here: the only push path today is the grade-specific notification
 * dispatcher in apps/workers, which has no generic "deliver this app.notifications row" entry point.
 */
export async function sendMessage(
  tx: TransactionSql,
  storage: StorageService | null,
  actor: MessagingActor,
  conversationId: string,
  input: SendMessageInput,
): Promise<Message> {
  const participants = await loadParticipants(tx, actor, conversationId);
  const callerIsParent = participants.parent_user_id === actor.userId;
  const recipientId = callerIsParent ? participants.teacher_user_id : participants.parent_user_id;
  if (await isBlockedBetween(tx, participants.parent_user_id, participants.teacher_user_id)) {
    throw blocked();
  }

  const body = input.body ?? "";
  const staged = input.attachments ?? [];
  if (body.length === 0 && staged.length === 0) {
    throw new CodedHttpException(400, ERROR_CODES.VALIDATION_FAILED, "Message is required");
  }
  const inspected =
    staged.length > 0 ? await inspectAttachments(tx, requireStorage(storage), actor, staged) : [];

  const [row] = await tx<MessageRow[]>`
    INSERT INTO app.messages (school_id, conversation_id, sender_user_id, body)
    VALUES (${actor.schoolId}::uuid, ${conversationId}::uuid, ${actor.userId}::uuid, ${body})
    RETURNING id, conversation_id, sender_user_id, body, created_at
  `;
  if (!row) throw new Error("INSERT INTO app.messages returned no row");

  const attachments: MessageAttachment[] = [];
  for (const [position, upload] of inspected.entries()) {
    const permanentKey = buildPermanentKey(
      actor.schoolId,
      upload.parsed.objectId,
      upload.parsed.filename,
    );
    // `storage` is non-null here: inspectAttachments ran through requireStorage for any image.
    const promoted = await promoteTempObject(storage!, upload.tempKey, permanentKey);
    await recordStorageUpload(tx, promoted.sizeBytes);
    const [attachment] = await tx<AttachmentRow[]>`
      INSERT INTO app.message_attachments (
        school_id, message_id, position, storage_key, original_file_name, mime_type, size_bytes,
        checksum_sha256
      ) VALUES (
        ${actor.schoolId}::uuid, ${row.id}::uuid, ${position}, ${permanentKey},
        ${upload.parsed.filename}, ${upload.contentType}, ${promoted.sizeBytes},
        ${upload.checksumSha256}
      )
      RETURNING id, message_id, storage_key, mime_type, size_bytes::text AS size_bytes
    `;
    attachments.push(await toAttachmentResponse(storage, attachment!));
  }

  if (callerIsParent) {
    await tx`
      UPDATE app.message_conversations
      SET last_message_at = greatest(last_message_at, ${row.created_at}::timestamptz),
          parent_last_read_at = greatest(coalesce(parent_last_read_at, '-infinity'), ${row.created_at}::timestamptz),
          updated_at = greatest(updated_at, clock_timestamp())
      WHERE school_id = ${actor.schoolId}::uuid AND id = ${conversationId}::uuid
    `;
  } else {
    await tx`
      UPDATE app.message_conversations
      SET last_message_at = greatest(last_message_at, ${row.created_at}::timestamptz),
          teacher_last_read_at = greatest(coalesce(teacher_last_read_at, '-infinity'), ${row.created_at}::timestamptz),
          updated_at = greatest(updated_at, clock_timestamp())
      WHERE school_id = ${actor.schoolId}::uuid AND id = ${conversationId}::uuid
    `;
  }

  await notifyRecipient(tx, actor, {
    conversationId,
    recipientId,
    body: row.body,
    attachmentCount: attachments.length,
  });

  // The body is deliberately not copied into the audit trail: a private message does not belong in
  // a log school administrators can browse. The row id, thread and shape are the record.
  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "messages",
    targetId: row.id,
    newValues: {
      conversation_id: conversationId,
      body_length: row.body.length,
      attachment_count: attachments.length,
    },
  });

  return toMessage(row, attachments);
}

async function notifyRecipient(
  tx: TransactionSql,
  actor: MessagingActor,
  params: { conversationId: string; recipientId: string; body: string; attachmentCount: number },
): Promise<void> {
  const [settings] = await tx<{ in_app_enabled: boolean; locale: string | null }[]>`
    SELECT in_app_enabled, locale
    FROM app.direct_message_recipient_settings(${params.recipientId}::uuid)
  `;
  if (!settings?.in_app_enabled) return;

  const [sender] = await tx<{ name: string }[]>`
    SELECT coalesce(display_name, email) AS name
    FROM app.users
    WHERE school_id = ${actor.schoolId}::uuid AND id = ${actor.userId}::uuid
  `;
  const locale = isTemplateLocale(settings.locale) ? settings.locale : "en";
  // An image-only message has no text to excerpt; the preview names what was sent instead.
  const preview =
    params.body.length === 0 && params.attachmentCount > 0
      ? locale === "ar"
        ? PHOTO_PREVIEW_AR
        : PHOTO_PREVIEW_EN
      : previewOf(params.body);
  const vars = { senderName: sender?.name ?? "", preview };
  const title = renderNotification(
    NOTIFICATION_TYPES.DIRECT_MESSAGE,
    NOTIFICATION_CHANNELS.IN_APP,
    locale,
    vars,
  ).trim();

  // No RETURNING: app.notifications' SELECT policy is owner-only, and PostgreSQL applies it to
  // RETURNING, so reading back a row addressed to someone else would be refused. The id is minted
  // here instead — the same reason packages/announcements does it.
  await tx`
    INSERT INTO app.notifications (id, school_id, user_id, notification_type, title, body, metadata)
    VALUES (
      ${crypto.randomUUID()}::uuid,
      ${actor.schoolId}::uuid,
      ${params.recipientId}::uuid,
      ${NOTIFICATION_TYPES.DIRECT_MESSAGE}::app.notification_type,
      ${title},
      ${vars.preview},
      ${tx.json({ conversation_id: params.conversationId })}
    )
  `;
}

/** Moves the caller's own read marker to now. */
export async function markConversationRead(
  tx: TransactionSql,
  actor: MessagingActor,
  conversationId: string,
): Promise<void> {
  const participants = await loadParticipants(tx, actor, conversationId);
  if (participants.parent_user_id === actor.userId) {
    await tx`
      UPDATE app.message_conversations
      SET parent_last_read_at = clock_timestamp(),
          updated_at = greatest(updated_at, clock_timestamp())
      WHERE school_id = ${actor.schoolId}::uuid AND id = ${conversationId}::uuid
    `;
  } else {
    await tx`
      UPDATE app.message_conversations
      SET teacher_last_read_at = clock_timestamp(),
          updated_at = greatest(updated_at, clock_timestamp())
      WHERE school_id = ${actor.schoolId}::uuid AND id = ${conversationId}::uuid
    `;
  }
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/** The caller's block state toward the other participant of a thread. */
export async function getBlockState(
  tx: TransactionSql,
  actor: MessagingActor,
  otherUserId: string,
): Promise<BlockState> {
  const [row] = await tx<BlockState[]>`
    SELECT
      EXISTS (
        SELECT 1
        FROM app.message_blocks
        WHERE school_id = ${actor.schoolId}::uuid
          AND blocker_user_id = ${actor.userId}::uuid
          AND blocked_user_id = ${otherUserId}::uuid
      ) AS blocked_by_me,
      app.message_user_has_blocked_me(${otherUserId}::uuid) AS has_blocked_me
  `;
  return row ?? { blocked_by_me: false, has_blocked_me: false };
}

/**
 * Blocks the other participant of a thread. Idempotent: `created` is false when the caller had
 * already blocked them (the route answers 200 instead of 201). A block stops new messages and new
 * threads between the pair in both directions; it hides no history.
 */
export async function blockConversationParticipant(
  tx: TransactionSql,
  actor: MessagingActor,
  conversationId: string,
): Promise<{ state: BlockState; created: boolean }> {
  const participants = await loadParticipants(tx, actor, conversationId);
  const other = otherParticipant(participants, actor);
  const created = await insertBlock(tx, actor, other.userId);
  return { state: await getBlockState(tx, actor, other.userId), created };
}

/** Inserts the caller's block of `blockedUserId` unless it exists; true when a row was written. */
export async function insertBlock(
  tx: TransactionSql,
  actor: MessagingActor,
  blockedUserId: string,
): Promise<boolean> {
  const [inserted] = await tx<{ id: string }[]>`
    INSERT INTO app.message_blocks (school_id, blocker_user_id, blocked_user_id)
    VALUES (${actor.schoolId}::uuid, ${actor.userId}::uuid, ${blockedUserId}::uuid)
    ON CONFLICT (school_id, blocker_user_id, blocked_user_id) DO NOTHING
    RETURNING id
  `;
  if (!inserted) return false;
  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "message_blocks",
    targetId: inserted.id,
    newValues: { blocker_user_id: actor.userId, blocked_user_id: blockedUserId },
  });
  return true;
}

/** Removes the caller's block of the other participant, if any. Idempotent. */
export async function unblockConversationParticipant(
  tx: TransactionSql,
  actor: MessagingActor,
  conversationId: string,
): Promise<void> {
  const participants = await loadParticipants(tx, actor, conversationId);
  const other = otherParticipant(participants, actor);
  const [deleted] = await tx<{ id: string }[]>`
    DELETE FROM app.message_blocks
    WHERE school_id = ${actor.schoolId}::uuid
      AND blocker_user_id = ${actor.userId}::uuid
      AND blocked_user_id = ${other.userId}::uuid
    RETURNING id
  `;
  if (deleted) {
    await emitAuditLog(tx, {
      action: "delete",
      targetTable: "message_blocks",
      targetId: deleted.id,
      oldValues: { blocker_user_id: actor.userId, blocked_user_id: other.userId },
    });
  }
}

// ---------------------------------------------------------------------------
// Participant profile
// ---------------------------------------------------------------------------

interface TeacherClassRow {
  class_id: string;
  class_code: string;
  course_name: string | null;
  subject_name: string | null;
}

interface ParentChildRow {
  student_id: string;
  student_name: string;
  relationship: ParentRelationship;
  is_conversation_student: boolean;
  class_id: string | null;
  class_code: string | null;
  course_name: string | null;
}

/**
 * What the caller may know about the other participant of a thread. A parent sees the teacher's
 * classes their child is in and the subjects the teacher teaches; a teacher sees the parent's
 * relationship to the thread's child and those of the parent's children they teach. Never contact
 * details. The class / child data comes from SECURITY DEFINER helpers (000137) because RLS hides
 * the other user's rows; each answers only to the thread's participant on the viewing side.
 */
export async function getParticipantProfile(
  tx: TransactionSql,
  actor: MessagingActor,
  conversationId: string,
): Promise<ParticipantProfile> {
  const participants = await loadParticipants(tx, actor, conversationId);
  const other = otherParticipant(participants, actor);

  const [user] = await tx<{ name: string }[]>`
    SELECT coalesce(display_name, email) AS name
    FROM app.users
    WHERE school_id = ${actor.schoolId}::uuid AND id = ${other.userId}::uuid
  `;
  const state = await getBlockState(tx, actor, other.userId);
  const base = {
    user_id: other.userId,
    name: user?.name ?? "",
    role: other.role,
    ...state,
  };

  if (other.role === "teacher") {
    const classes = await tx<TeacherClassRow[]>`
      SELECT class_id, class_code, course_name, subject_name
      FROM app.message_profile_teacher_classes(${conversationId}::uuid)
      ORDER BY class_code, class_id
    `;
    const subjects = await tx<{ subject_name: string }[]>`
      SELECT subject_name
      FROM app.message_profile_teacher_subjects(${conversationId}::uuid)
      ORDER BY subject_name
    `;
    return {
      ...base,
      classes: classes.map((row) => ({
        id: row.class_id,
        code: row.class_code,
        course_name: row.course_name,
        subject_name: row.subject_name,
      })),
      subjects: subjects.map((row) => row.subject_name),
      relationship: null,
      children: [],
    };
  }

  const rows = await tx<ParentChildRow[]>`
    SELECT student_id, student_name, relationship, is_conversation_student,
           class_id, class_code, course_name
    FROM app.message_profile_parent_children(${conversationId}::uuid)
    ORDER BY is_conversation_student DESC, student_name, student_id, class_code, class_id
  `;
  type Child = ParticipantProfile["children"][number];
  const byStudent = new Map<string, Child>();
  for (const row of rows) {
    let child = byStudent.get(row.student_id);
    if (!child) {
      child = {
        id: row.student_id,
        name: row.student_name,
        relationship: row.relationship,
        is_conversation_student: row.is_conversation_student,
        classes: [],
      };
      byStudent.set(row.student_id, child);
    }
    if (row.class_id !== null && row.class_code !== null) {
      child.classes.push({ id: row.class_id, code: row.class_code, course_name: row.course_name });
    }
  }
  const children = [...byStudent.values()];
  return {
    ...base,
    classes: [],
    subjects: [],
    relationship: children.find((child) => child.is_conversation_student)?.relationship ?? null,
    children,
  };
}
