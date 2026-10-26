// Academic structure: one active academic year with two terms, two subjects/courses, a physical and a
// virtual room, grades and sections (Grade 10 A-C, Grade 11 A), two classes (each with a lead
// teacher, a room and a section), and student enrollments with each student placed in a section. The year
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

  // Grades and sections (000147). Science is taught to 10-A and Math to 10-B; 10-C and 11-A start
  // empty so a demo can add classes and students to them.
  const grade10 = uuid();
  const grade11 = uuid();
  await sql`
    INSERT INTO app.grade_levels ${sql(
      [
        { id: grade10, school_id: schoolId, name: "Grade 10", sort_order: 10 },
        { id: grade11, school_id: schoolId, name: "Grade 11", sort_order: 11 },
      ],
      "id",
      "school_id",
      "name",
      "sort_order",
    )}
  `;
  const sections = [
    { id: uuid(), grade_level_id: grade10, name: "A" },
    { id: uuid(), grade_level_id: grade10, name: "B" },
    { id: uuid(), grade_level_id: grade10, name: "C" },
    { id: uuid(), grade_level_id: grade11, name: "A" },
  ];
  await sql`
    INSERT INTO app.sections ${sql(
      sections.map((section) => ({
        ...section,
        school_id: schoolId,
        academic_year_id: academicYearId,
      })),
      "id",
      "school_id",
      "academic_year_id",
      "grade_level_id",
      "name",
    )}
  `;
  const [section10A, section10B] = sections;

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
        section_id: klass.code === "SCI101-A" ? section10A!.id : section10B!.id,
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
      "section_id",
      "code",
      "capacity",
      "status",
    )}
  `;

  // Enroll students: the first five in Science, everyone from the fourth on in Math (overlapping in
  // the middle), so both classes are populated and some students appear in both. Math runs to the end
  // of the roster so a student appended to the persona list (e.g. Mira Fares, whose brother Adam is
  // Science-only) lands in Math and gets a different timetable from her sibling.
  const scienceClass = classes[0]!;
  const mathClass = classes[1]!;
  const enrollments: SeededEnrollment[] = [
    ...students
      .slice(0, 5)
      .map((student) => ({ classId: scienceClass.id, studentId: student.studentId })),
    ...students
      .slice(3)
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

  // Each student sits in the section of the class they joined first: the Science five in 10-A, the
  // rest in 10-B (the two who also take Math keep 10-A).
  await sql`
    INSERT INTO app.student_sections ${sql(
      students.map((student, index) => ({
        school_id: schoolId,
        student_id: student.studentId,
        academic_year_id: academicYearId,
        section_id: index < 5 ? section10A!.id : section10B!.id,
      })),
      "school_id",
      "student_id",
      "academic_year_id",
      "section_id",
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
