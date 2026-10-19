// Parent<->teacher messaging (migration 000127): one demo thread between the Fares parent and Adam's
// science teacher, Layla Nasser, about Adam, plus the in-app DIRECT_MESSAGE notification the last
// message left for the parent. Written as studafy_admin inside the seed's single transaction, so the
// participant-only policies (TO studafy_app) do not apply and tenant_isolation still does.
//
// The thread obeys the same rule the API enforces: Adam is linked to the parent and enrolled in
// SCI101-A, whose lead teacher is Layla. A tenant whose roster lacks any of the three (the reviewer
// tenant's personas differ) gets no thread rather than a thread the rule would refuse.
import { seedDate, uuid } from "../support";

import type { FullCtx, Sql } from "../support";

const THREAD: readonly { from: "parent" | "teacher"; hour: number; body: string }[] = [
  {
    from: "parent",
    hour: 9,
    body:
      "Good morning Ms. Nasser, Adam mentioned he found the photosynthesis lab difficult. " +
      "Is there anything we can practise with him at home?",
  },
  {
    from: "teacher",
    hour: 11,
    body:
      "Good morning Mr. Fares, thanks for reaching out. Adam understands the concepts well; the " +
      "lab write-up is where he loses marks. Reviewing the report template together would help.",
  },
  {
    from: "parent",
    hour: 12,
    body: "That's helpful, thank you. We'll go through the template this weekend.",
  },
  {
    from: "teacher",
    hour: 14,
    body: "Wonderful. I'll also share a sample report on the class page so he has a model to follow.",
  },
];

export async function seedMessaging(sql: Sql, ctx: FullCtx): Promise<void> {
  const parent = ctx.parents.find((person) => person.key === "parent-fares");
  const student = ctx.students.find((person) => person.key === "student-adam");
  const teacher = ctx.teachers.find((person) => person.key === "instructor-science");
  const scienceClass = ctx.classes.find((klass) => klass.code === "SCI101-A");
  if (!parent || !student || !teacher || scienceClass?.leadTeacherId !== teacher.teacherId) return;

  const day = -1;
  const conversationId = uuid();
  const startedAt = seedDate(day, 9);
  const messages = THREAD.map((message) => ({
    id: uuid(),
    senderUserId: message.from === "parent" ? parent.userId : teacher.userId,
    body: message.body,
    createdAt: seedDate(day, message.hour),
  }));
  const last = messages[messages.length - 1]!;
  // The teacher has read everything (they sent the last message); the parent has read up to their
  // own reply, so the teacher's last message shows as one unread.
  const parentLastRead = messages[2]!.createdAt;

  await sql`
    INSERT INTO app.message_conversations (
      id, school_id, parent_user_id, teacher_user_id, student_id,
      last_message_at, parent_last_read_at, teacher_last_read_at, created_at, updated_at
    ) VALUES (
      ${conversationId}, ${ctx.schoolId}, ${parent.userId}, ${teacher.userId}, ${student.studentId},
      ${last.createdAt}, ${parentLastRead}, ${last.createdAt}, ${startedAt}, ${last.createdAt}
    )
  `;

  await sql`
    INSERT INTO app.messages ${sql(
      messages.map((message) => ({
        id: message.id,
        school_id: ctx.schoolId,
        conversation_id: conversationId,
        sender_user_id: message.senderUserId,
        body: message.body,
        created_at: message.createdAt,
      })),
      "id",
      "school_id",
      "conversation_id",
      "sender_user_id",
      "body",
      "created_at",
    )}
  `;

  await sql`
    INSERT INTO app.notifications
      (id, school_id, user_id, notification_type, title, body, metadata, created_at)
    VALUES (
      ${uuid()}, ${ctx.schoolId}, ${parent.userId}, 'DIRECT_MESSAGE',
      ${`New message from ${teacher.displayName}`}, ${last.body},
      ${sql.json({ conversation_id: conversationId })}, ${last.createdAt}
    )
  `;
}
