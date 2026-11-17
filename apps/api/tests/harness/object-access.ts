/**
 * A school shaped for horizontal (object-level) authorization tests (QA-002).
 *
 * Role gates answer "may a teacher read grades?"; these fixtures answer "may *this* teacher read
 * *that* student's grades?". One school with two classes and the relationships that decide access,
 * plus a second school to prove nothing crosses the tenant boundary:
 *
 *   school A
 *     class X  -- lead teacher A,  student S1 (guardian: parent P1, and the dual user)
 *     class Y  -- lead teacher B,  student S2
 *     dual     -- teacher B's own user holding INSTRUCTOR *and* PARENT, guardian of S1: the
 *                 multi-role case (teacher B's plain actor carries INSTRUCTOR only)
 *     ORG_ADMIN, PRINCIPAL, FINANCE, ATTENDANCE_OFFICER -- school-wide staff
 *   school B
 *     class Z  -- lead teacher C,  student S3; its own ORG_ADMIN
 */
import { ROLES } from "@studafy/constants";

import {
  assignRole,
  createAcademicYear,
  createClass,
  createCourse,
  createEnrollment,
  createRoom,
  createSchool,
  createStudent,
  createSubject,
  createTeacher,
  createTerm,
  createUser,
} from "./factories";
import { mintTestToken } from "./request";

import type { KeyStore } from "../../src/modules/auth";
import type { Role } from "@studafy/constants";
import type { Sql } from "postgres";

export interface Actor {
  /** Short label used in test names, e.g. "teacherA". */
  label: string;
  userId: string;
  roles: Role[];
}

export interface StudentRef {
  /** app.students.id */
  id: string;
  userId: string;
}

export interface SchoolUnderTest {
  schoolId: string;
  termId: string;
  classX: string;
  classY: string;
  s1: StudentRef;
  s2: StudentRef;
  actors: {
    orgAdmin: Actor;
    principal: Actor;
    finance: Actor;
    attendanceOfficer: Actor;
    teacherA: Actor;
    teacherB: Actor;
    s1: Actor;
    s2: Actor;
    parentP1: Actor;
    dual: Actor;
  };
}

export interface OtherSchool {
  schoolId: string;
  classZ: string;
  s3: StudentRef;
  actors: { orgAdmin: Actor; teacherC: Actor; s3: Actor };
}

async function staff(sql: Sql, schoolId: string, label: string, role: Role): Promise<Actor> {
  const user = await createUser(sql, schoolId, { displayName: `${label} (${role})` });
  await assignRole(sql, schoolId, user.id, role);
  return { label, userId: user.id, roles: [role] };
}

async function student(sql: Sql, schoolId: string, label: string) {
  const record = await createStudent(sql, schoolId, { firstName: label, lastName: "Student" });
  await assignRole(sql, schoolId, record.userId, ROLES.STUDENT);
  const ref: StudentRef = { id: record.id, userId: record.userId };
  const actor: Actor = { label, userId: record.userId, roles: [ROLES.STUDENT] };
  return { ref, actor };
}

async function teacher(sql: Sql, schoolId: string, label: string) {
  const record = await createTeacher(sql, schoolId);
  await assignRole(sql, schoolId, record.userId, ROLES.INSTRUCTOR);
  return {
    teacherId: record.id,
    actor: { label, userId: record.userId, roles: [ROLES.INSTRUCTOR] },
  };
}

async function linkGuardian(
  sql: Sql,
  schoolId: string,
  parentUserId: string,
  studentId: string,
): Promise<void> {
  const [family] = await sql<{ id: string }[]>`
    INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
    VALUES (${schoolId}::uuid, 'Family', ${parentUserId}::uuid)
    RETURNING id
  `;
  await sql`
    INSERT INTO app.parent_child_links (school_id, family_id, parent_user_id, student_id, relationship)
    VALUES (${schoolId}::uuid, ${family!.id}::uuid, ${parentUserId}::uuid, ${studentId}::uuid, 'guardian')
  `;
}

async function academicFrame(sql: Sql, schoolId: string, slug: string) {
  const year = await createAcademicYear(sql, schoolId, { code: `AY-${slug}` });
  const term = await createTerm(sql, schoolId, year.id, { code: `T1-${slug}` });
  const subject = await createSubject(sql, schoolId, { code: `SUBJ-${slug}` });
  const course = await createCourse(sql, schoolId, subject.id, { code: `CRS-${slug}` });
  const room = await createRoom(sql, schoolId, { code: `RM-${slug}` });
  return { year, term, course, room };
}

export async function createSchoolUnderTest(sql: Sql): Promise<SchoolUnderTest> {
  const school = await createSchool(sql);
  const frame = await academicFrame(sql, school.id, school.slug);

  const teacherA = await teacher(sql, school.id, "teacherA");
  const teacherB = await teacher(sql, school.id, "teacherB");
  const classX = await createClass(sql, school.id, {
    courseId: frame.course.id,
    academicYearId: frame.year.id,
    termId: frame.term.id,
    leadTeacherId: teacherA.teacherId,
    roomId: frame.room.id,
    code: `X-${school.slug}`,
  });
  const classY = await createClass(sql, school.id, {
    courseId: frame.course.id,
    academicYearId: frame.year.id,
    termId: frame.term.id,
    leadTeacherId: teacherB.teacherId,
    roomId: frame.room.id,
    code: `Y-${school.slug}`,
  });

  const s1 = await student(sql, school.id, "s1");
  const s2 = await student(sql, school.id, "s2");
  await createEnrollment(sql, school.id, classX.id, s1.ref.id);
  await createEnrollment(sql, school.id, classY.id, s2.ref.id);

  const parentP1 = await staff(sql, school.id, "parentP1", ROLES.PARENT);
  await linkGuardian(sql, school.id, parentP1.userId, s1.ref.id);

  // The dual user is teacher B (lead teacher of class Y, the only form of "teaches" -- see
  // app.teaches_class) who is also S1's guardian: one person, two roles, two relationships.
  await assignRole(sql, school.id, teacherB.actor.userId, ROLES.PARENT);
  await linkGuardian(sql, school.id, teacherB.actor.userId, s1.ref.id);

  return {
    schoolId: school.id,
    termId: frame.term.id,
    classX: classX.id,
    classY: classY.id,
    s1: s1.ref,
    s2: s2.ref,
    actors: {
      orgAdmin: await staff(sql, school.id, "orgAdmin", ROLES.ORG_ADMIN),
      principal: await staff(sql, school.id, "principal", ROLES.PRINCIPAL),
      finance: await staff(sql, school.id, "finance", ROLES.FINANCE),
      attendanceOfficer: await staff(sql, school.id, "attendanceOfficer", ROLES.ATTENDANCE_OFFICER),
      teacherA: teacherA.actor,
      teacherB: teacherB.actor,
      s1: s1.actor,
      s2: s2.actor,
      parentP1,
      dual: {
        label: "dual",
        userId: teacherB.actor.userId,
        roles: [ROLES.INSTRUCTOR, ROLES.PARENT],
      },
    },
  };
}

export async function createOtherSchool(sql: Sql): Promise<OtherSchool> {
  const school = await createSchool(sql);
  const frame = await academicFrame(sql, school.id, school.slug);
  const teacherC = await teacher(sql, school.id, "teacherC");
  const classZ = await createClass(sql, school.id, {
    courseId: frame.course.id,
    academicYearId: frame.year.id,
    termId: frame.term.id,
    leadTeacherId: teacherC.teacherId,
    roomId: frame.room.id,
    code: `Z-${school.slug}`,
  });
  const s3 = await student(sql, school.id, "s3");
  await createEnrollment(sql, school.id, classZ.id, s3.ref.id);
  return {
    schoolId: school.id,
    classZ: classZ.id,
    s3: s3.ref,
    actors: {
      orgAdmin: await staff(sql, school.id, "orgAdminB", ROLES.ORG_ADMIN),
      teacherC: teacherC.actor,
      s3: s3.actor,
    },
  };
}

/** A bearer token for `actor` in `schoolId`, on the web channel unless told otherwise. */
export function tokenFor(
  keyStore: KeyStore,
  schoolId: string,
  actor: Actor,
  channel: "web" | "mobile" = "web",
): Promise<string> {
  return mintTestToken(keyStore, { schoolId, userId: actor.userId, roles: actor.roles, channel });
}
