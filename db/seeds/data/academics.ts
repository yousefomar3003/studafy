// Academic structure: one active academic year with two terms, two subjects/courses, a physical and a
// virtual room, two classes (each with a lead teacher and a room), and student enrollments. The year
// spans the current wall-clock month so that later attendance dated in July 2026 is coherent with an
// in-progress term. Composite foreign keys require every referenced row to share the demo school_id,
// which holds by construction here.
import { seedDate, uuid } from "../support";

import type {
  AcademicsCtx,
  PeopleCtx,
  SchoolCtx,
  SeededClass,
  SeededEnrollment,
  Sql,
} from "../support";

export async function seedAcademics(sql: Sql, ctx: SchoolCtx & PeopleCtx): Promise<AcademicsCtx> {
  const { schoolId, teachers, students } = ctx;

  const teacherByKey = new Map(teachers.map((teacher) => [teacher.key, teacher]));
  const scienceTeacher = teacherByKey.get("instructor-science")!;
  const mathTeacher = teacherByKey.get("instructor-math")!;

  const academicYearId = uuid();
  await sql`
    INSERT INTO app.academic_years ${sql({
      id: academicYearId,
      school_id: schoolId,
      code: "AY2026-2027",
      name: "2026–2027",
      starts_on: "2026-07-01",
      ends_on: "2027-06-30",
      status: "active",
    })}
  `;

  const terms = [
    {
      id: uuid(),
      code: "T1",
      sequence: 1,
      starts_on: "2026-07-01",
      ends_on: "2026-12-31",
      status: "active",
    },
    {
      id: uuid(),
      code: "T2",
      sequence: 2,
      starts_on: "2027-01-01",
      ends_on: "2027-06-30",
      status: "planned",
    },
  ];
  await sql`
    INSERT INTO app.terms ${sql(
      terms.map((term) => ({
        id: term.id,
        school_id: schoolId,
        academic_year_id: academicYearId,
        code: term.code,
        name: `Term ${term.sequence}`,
        sequence_number: term.sequence,
        starts_on: term.starts_on,
        ends_on: term.ends_on,
        status: term.status,
      })),
      "id",
      "school_id",
      "academic_year_id",
      "code",
      "name",
      "sequence_number",
      "starts_on",
      "ends_on",
      "status",
    )}
  `;
  const term1 = terms[0]!;

  const subjects = [
    { id: uuid(), code: "SCI", name: "Science" },
    { id: uuid(), code: "MATH", name: "Mathematics" },
  ];
  await sql`
    INSERT INTO app.subjects ${sql(
      subjects.map((subject) => ({
        id: subject.id,
        school_id: schoolId,
        code: subject.code,
        name: subject.name,
        status: "active",
      })),
      "id",
      "school_id",
      "code",
      "name",
      "status",
    )}
  `;

  const courses = [
    { id: uuid(), code: "SCI101", name: "Integrated Science", subjectId: subjects[0]!.id },
    { id: uuid(), code: "MATH101", name: "Algebra Foundations", subjectId: subjects[1]!.id },
  ];
  await sql`
    INSERT INTO app.courses ${sql(
      courses.map((course) => ({
        id: course.id,
        school_id: schoolId,
        subject_id: course.subjectId,
        code: course.code,
        name: course.name,
        status: "active",
      })),
      "id",
      "school_id",
      "subject_id",
      "code",
      "name",
      "status",
    )}
  `;

  const physicalRoom = { id: uuid(), code: "R101" };
  const virtualRoom = { id: uuid(), code: "VR01" };
  await sql`
    INSERT INTO app.rooms ${sql(
      [
        {
          id: physicalRoom.id,
          school_id: schoolId,
          code: physicalRoom.code,
          name: "Science Lab 101",
          room_type: "physical",
          capacity: 30,
          building: "Main Building",
          floor: "1",
          virtual_url: null,
          is_active: true,
        },
        {
          id: virtualRoom.id,
          school_id: schoolId,
          code: virtualRoom.code,
          name: "Virtual Classroom 1",
          room_type: "virtual",
          capacity: 100,
          building: null,
          floor: null,
          virtual_url: "https://meet.demo.studafy.test/vr01",
          is_active: true,
        },
      ],
      "id",
      "school_id",
      "code",
      "name",
      "room_type",
      "capacity",
      "building",
      "floor",
      "virtual_url",
      "is_active",
    )}
  `;

  const classes: SeededClass[] = [
    {
      id: uuid(),
      code: "SCI101-A",
      courseId: courses[0]!.id,
      termId: term1.id,
      academicYearId,
      leadTeacherId: scienceTeacher.teacherId,
      roomId: physicalRoom.id,
    },
    {
      id: uuid(),
      code: "MATH101-A",
      courseId: courses[1]!.id,
      termId: term1.id,
      academicYearId,
      leadTeacherId: mathTeacher.teacherId,
      roomId: virtualRoom.id,
    },
  ];
  await sql`
    INSERT INTO app.classes ${sql(
      classes.map((klass) => ({
        id: klass.id,
        school_id: schoolId,
        course_id: klass.courseId,
        academic_year_id: klass.academicYearId,
        term_id: klass.termId,
        lead_teacher_id: klass.leadTeacherId,
        room_id: klass.roomId,
        code: klass.code,
        capacity: 30,
        status: "active",
      })),
      "id",
      "school_id",
      "course_id",
      "academic_year_id",
      "term_id",
      "lead_teacher_id",
      "room_id",
      "code",
      "capacity",
      "status",
    )}
  `;

  // Enroll students: the first five in Science, the last five in Math (overlapping in the middle), so
  // both classes are populated and some students appear in both.
  const scienceClass = classes[0]!;
  const mathClass = classes[1]!;
  const enrollments: SeededEnrollment[] = [
    ...students
      .slice(0, 5)
      .map((student) => ({ classId: scienceClass.id, studentId: student.studentId })),
    ...students
      .slice(3, 8)
      .map((student) => ({ classId: mathClass.id, studentId: student.studentId })),
  ];
  await sql`
    INSERT INTO app.enrollments ${sql(
      enrollments.map((enrollment) => ({
        school_id: schoolId,
        class_id: enrollment.classId,
        student_id: enrollment.studentId,
        status: "active",
        enrolled_at: seedDate(-20),
      })),
      "school_id",
      "class_id",
      "student_id",
      "status",
      "enrolled_at",
    )}
  `;

  return {
    academicYearId,
    terms: terms.map((term) => ({ id: term.id, code: term.code, sequence: term.sequence })),
    subjects: subjects.map((subject) => ({ id: subject.id, code: subject.code })),
    courses: courses.map((course) => ({
      id: course.id,
      code: course.code,
      subjectId: course.subjectId,
    })),
    rooms: [physicalRoom, virtualRoom],
    classes,
    enrollments,
  };
}
