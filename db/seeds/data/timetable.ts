// Timetable and attendance. A single timetable version is built while it is a draft (the only state in
// which slots may be written), then transitioned draft -> pending -> approved via UPDATEs, because the
// approval state machine's timestamps/actors are written by the 000010 trigger, never inserted. Two
// attendance sessions are then recorded for the Science class. Attendance rows are dated inside the
// 2026-07 partition, and each record carries the parent session's created_at exactly (timestamptz(3)
// equality across the driver round-trip). The session/record key registries are trigger-maintained, so
// this module never touches them.
import { seedDate, uuid } from "../support";

import type { FullCtx, Sql } from "../support";

export async function seedTimetableAndAttendance(sql: Sql, ctx: FullCtx): Promise<void> {
  const { schoolId, academicYearId, terms, classes, teachers, orgAdmin, enrollments } = ctx;
  const term1 = terms[0]!;
  const scienceClass = classes[0]!;
  const mathClass = classes[1]!;
  const scienceTeacher = teachers.find((t) => t.key === "instructor-science")!;

  // --- Timetable version (draft) ---
  const versionId = uuid();
  await sql`
    INSERT INTO app.timetable_versions ${sql({
      id: versionId,
      school_id: schoolId,
      academic_year_id: academicYearId,
      term_id: term1.id,
      name: "Term 1 Weekly Schedule",
      status: "draft",
    })}
  `;

  // Slots. teacher_id/room_id mirror each class's lead teacher and room. No teacher or room is booked
  // twice in the same (version, weekday, period), satisfying the two EXCLUDE constraints.
  const slots = [
    {
      classId: scienceClass.id,
      teacherId: scienceClass.leadTeacherId,
      roomId: scienceClass.roomId,
      weekday: 1,
      period: 1,
    },
    {
      classId: scienceClass.id,
      teacherId: scienceClass.leadTeacherId,
      roomId: scienceClass.roomId,
      weekday: 3,
      period: 1,
    },
    {
      classId: mathClass.id,
      teacherId: mathClass.leadTeacherId,
      roomId: mathClass.roomId,
      weekday: 1,
      period: 2,
    },
    {
      classId: mathClass.id,
      teacherId: mathClass.leadTeacherId,
      roomId: mathClass.roomId,
      weekday: 2,
      period: 1,
    },
  ];
  await sql`
    INSERT INTO app.timetable_slots ${sql(
      slots.map((slot) => ({
        id: uuid(),
        school_id: schoolId,
        timetable_version_id: versionId,
        class_id: slot.classId,
        teacher_id: slot.teacherId,
        room_id: slot.roomId,
        weekday: slot.weekday,
        period: slot.period,
      })),
      "id",
      "school_id",
      "timetable_version_id",
      "class_id",
      "teacher_id",
      "room_id",
      "weekday",
      "period",
    )}
  `;

  // Transition to the live schedule. The trigger sets submitted_at/approved_at; we only supply the actor
  // and the target status.
  await sql`
    UPDATE app.timetable_versions
    SET status = 'pending', submitted_by_user_id = ${orgAdmin.userId}
    WHERE id = ${versionId} AND school_id = ${schoolId}
  `;
  await sql`
    UPDATE app.timetable_versions
    SET status = 'approved', approved_by_user_id = ${orgAdmin.userId}
    WHERE id = ${versionId} AND school_id = ${schoolId}
  `;

  // --- Attendance for the Science class ---
  const scienceStudentIds = enrollments
    .filter((enrollment) => enrollment.classId === scienceClass.id)
    .map((enrollment) => enrollment.studentId);

  // Two taken sessions on distinct dates. created_at is pinned to a .000ms instant so the record ->
  // session key foreign key matches exactly.
  const sessions = [
    { id: uuid(), date: "2026-07-06", createdAt: seedDate(0, 8) },
    { id: uuid(), date: "2026-07-08", createdAt: seedDate(2, 8) },
  ];
  await sql`
    INSERT INTO app.attendance_sessions ${sql(
      sessions.map((session) => ({
        id: session.id,
        school_id: schoolId,
        class_id: scienceClass.id,
        session_date: session.date,
        period: 1,
        status: "submitted",
        taken_by_user_id: scienceTeacher.userId,
        created_at: session.createdAt,
      })),
      "id",
      "school_id",
      "class_id",
      "session_date",
      "period",
      "status",
      "taken_by_user_id",
      "created_at",
    )}
  `;

  // One record per enrolled student per session. Vary the status so the demo shows more than "present".
  const statuses = ["present", "present", "late", "absent", "excused"] as const;
  const recordRows = sessions.flatMap((session) =>
    scienceStudentIds.map((studentId, index) => {
      const status = statuses[index % statuses.length]!;
      return {
        id: uuid(),
        school_id: schoolId,
        attendance_session_id: session.id,
        session_created_at: session.createdAt,
        student_id: studentId,
        status,
        minutes_late: status === "late" ? 8 : null,
        recorded_by_user_id: scienceTeacher.userId,
        created_at: session.createdAt,
      };
    }),
  );
  await sql`
    INSERT INTO app.attendance_records ${sql(
      recordRows,
      "id",
      "school_id",
      "attendance_session_id",
      "session_created_at",
      "student_id",
      "status",
      "minutes_late",
      "recorded_by_user_id",
      "created_at",
    )}
  `;
}
