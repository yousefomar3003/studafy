// Engagement + operational tables: in-app notifications and append-only audit logs, plus the local-only
// push-device registrations and domain-event outbox (seedLocalFixtures). Tables carrying a JSONB payload (notifications.metadata,
// outbox_events.payload, audit_logs.new_values) are inserted with explicit VALUES and sql.json so the
// payload is bound as jsonb. audit_logs is append-only and partitioned by created_at (2026-07 window).
// notification_preferences are NOT seeded here — the 000017 trigger populated them when each user was
// created with status 'active'.
import { seedDate, uuid } from "../support";

import type { FullCtx, Sql } from "../support";

export async function seedEngagement(sql: Sql, ctx: FullCtx): Promise<void> {
  const { schoolId, students, orgAdmin } = ctx;
  const notifiedStudents = students.slice(0, 4);

  // Notifications (metadata is a jsonb object).
  for (const [index, student] of notifiedStudents.entries()) {
    const unread = index % 2 === 0;
    await sql`
      INSERT INTO app.notifications
        (id, school_id, user_id, notification_type, title, body, metadata, read_at, created_at)
      VALUES (
        ${uuid()}, ${schoolId}, ${student.userId}, 'GRADE_POSTED',
        'Your grade was posted', 'A new grade is available for Unit 1 Science Exam.',
        ${sql.json({ deepLink: "/grades", examTitle: "Unit 1 Science Exam" })},
        ${unread ? null : seedDate(-1)}, ${seedDate(-2)}
      )
    `;
  }
  await sql`
    INSERT INTO app.notifications
      (id, school_id, user_id, notification_type, title, body, metadata, created_at)
    VALUES (
      ${uuid()}, ${schoolId}, ${notifiedStudents[0]!.userId}, 'ASSIGNMENT_DUE_SOON',
      'Assignment due soon', 'Photosynthesis Lab Report is due in 2 days.',
      ${sql.json({ deepLink: "/assignments" })}, ${seedDate(-1)}
    )
  `;

  // Append-only audit log (INSERT only; new_values is jsonb for the 'insert' action).
  await sql`
    INSERT INTO app.audit_logs
      (id, school_id, actor_id, action, target_table, target_id, new_values, client_ip, created_at)
    VALUES (
      ${uuid()}, ${schoolId}, ${orgAdmin.userId}, 'insert', 'schools', ${schoolId},
      ${sql.json({ slug: ctx.schoolSlug, status: "active" })}, '203.0.113.10', ${seedDate(-3)}
    )
  `;
  await sql`
    INSERT INTO app.audit_logs
      (id, school_id, actor_id, action, target_table, target_id, client_ip, created_at)
    VALUES (
      ${uuid()}, ${schoolId}, ${orgAdmin.userId}, 'login', 'users', ${orgAdmin.userId},
      '203.0.113.10', ${seedDate(-1)}
    )
  `;
}

// Push-device registrations with fake FCM tokens and not-yet-relayed domain events. Local only
// (TenantProfile.localFixtures): in a deployed environment the push sender would call FCM with these
// tokens and the outbox relay would publish these events.
export async function seedLocalFixtures(sql: Sql, ctx: FullCtx): Promise<void> {
  const { schoolId, students, orgAdmin } = ctx;
  const notifiedStudents = students.slice(0, 4);

  // Push-device registrations.
  await sql`
    INSERT INTO app.user_devices ${sql(
      [
        {
          id: uuid(),
          school_id: schoolId,
          user_id: notifiedStudents[0]!.userId,
          fcm_token: `mock-fcm-${notifiedStudents[0]!.userId}`,
          platform: "ios",
          last_seen: seedDate(-1),
          created_at: seedDate(-2),
        },
        {
          id: uuid(),
          school_id: schoolId,
          user_id: orgAdmin.userId,
          fcm_token: `mock-fcm-${orgAdmin.userId}`,
          platform: "web",
          last_seen: seedDate(-1),
          created_at: seedDate(-2),
        },
      ],
      "id",
      "school_id",
      "user_id",
      "fcm_token",
      "platform",
      "last_seen",
      "created_at",
    )}
  `;

  // Domain-event outbox (payload is jsonb; event_name matches resource.pastTenseAction).
  const events: { name: string; payload: Record<string, string> }[] = [
    { name: "user.created", payload: { userId: orgAdmin.userId, role: "ORG_ADMIN" } },
    { name: "grade.published", payload: { gradebookClass: "SCI101-A" } },
  ];
  for (const event of events) {
    await sql`
      INSERT INTO app.outbox_events (school_id, event_name, payload, created_at)
      VALUES (${schoolId}, ${event.name}, ${sql.json(event.payload)}, ${seedDate(-1)})
    `;
  }
}

// School calendar (migration 000121): one entry of each kind around the seed's "today", so the
// calendar, the timetable's holiday shading and the parent/student "upcoming" lists have data.
const SCHOOL_EVENTS: readonly {
  kind: "holiday" | "event" | "meeting" | "exam_period";
  title: string;
  description: string | null;
  startDay: number;
  endDay: number;
}[] = [
  { kind: "meeting", title: "Parent-teacher evening", description: null, startDay: 3, endDay: 3 },
  {
    kind: "event",
    title: "Science fair",
    description: "Grade projects on display in the main hall; families welcome.",
    startDay: 10,
    endDay: 10,
  },
  { kind: "exam_period", title: "Mid-term exams", description: null, startDay: 21, endDay: 25 },
  { kind: "holiday", title: "Mid-term break", description: null, startDay: 28, endDay: 32 },
];

export async function seedSchoolEvents(sql: Sql, ctx: FullCtx): Promise<void> {
  await sql`
    INSERT INTO app.school_events ${sql(
      SCHOOL_EVENTS.map((event) => ({
        id: uuid(),
        school_id: ctx.schoolId,
        created_by: ctx.orgAdmin.userId,
        title: event.title,
        description: event.description,
        kind: event.kind,
        starts_on: seedDate(event.startDay).toISOString().slice(0, 10),
        ends_on: seedDate(event.endDay).toISOString().slice(0, 10),
      })),
    )}
  `;
}
