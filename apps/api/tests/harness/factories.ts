import type { Role } from "../../../../packages/constants/src/roles";
import type { Sql, TransactionSql } from "postgres";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function asAdmin<T>(sql: Sql, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  let result: T | undefined;
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    result = await fn(tx);
  });
  return result as T;
}

// ---------------------------------------------------------------------------
// School (global table — requires studafy_admin)
// ---------------------------------------------------------------------------

export interface SchoolRecord {
  id: string;
  slug: string;
}

export async function createSchool(
  sql: Sql,
  overrides?: { slug?: string; name?: string },
): Promise<SchoolRecord> {
  const slug = overrides?.slug ?? `test-${crypto.randomUUID().slice(0, 8)}`;
  const name = overrides?.name ?? `Test School ${slug}`;

  return asAdmin(sql, async (tx) => {
    const [reference] = await tx<{ country: string; currency: string }[]>`
      SELECT
        (SELECT id FROM app.countries WHERE alpha2_code = 'US') AS country,
        (SELECT id FROM app.currencies WHERE code = 'USD') AS currency
    `;

    const [school] = await tx<{ id: string; slug: string }[]>`
      INSERT INTO app.schools (slug, name, country_id, default_currency_id)
      VALUES (${slug}, ${name}, ${reference!.country}, ${reference!.currency})
      RETURNING id, slug
    `;

    return school!;
  });
}

// ---------------------------------------------------------------------------
// User + Role
// ---------------------------------------------------------------------------

export interface UserRecord {
  id: string;
  email: string;
  normalizedEmail: string;
}

export async function createUser(
  sql: Sql,
  schoolId: string,
  overrides?: { email?: string; displayName?: string; status?: string },
): Promise<UserRecord> {
  const email = overrides?.email ?? `user-${crypto.randomUUID().slice(0, 8)}@test.local`;
  const normalizedEmail = email.toLowerCase().trim();

  return asAdmin(sql, async (tx) => {
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    await tx.unsafe("SET LOCAL ROLE studafy_app");

    const [user] = await tx<{ id: string; email: string; normalized_email: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
      VALUES (
        ${schoolId},
        ${email},
        ${normalizedEmail},
        ${overrides?.displayName ?? null},
        ${(overrides?.status as "active" | "invited" | "suspended" | "archived") ?? "active"}
      )
      RETURNING id, email, normalized_email
    `;

    return { id: user!.id, email: user!.email, normalizedEmail: user!.normalized_email };
  });
}

export async function assignRole(
  sql: Sql,
  schoolId: string,
  userId: string,
  role: Role,
): Promise<void> {
  await asAdmin(sql, async (tx) => {
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    await tx.unsafe("SET LOCAL ROLE studafy_app");

    await tx`
      INSERT INTO app.user_roles (school_id, user_id, role)
      VALUES (${schoolId}, ${userId}, ${role}::app.user_role)
    `;
  });
}

// ---------------------------------------------------------------------------
// Student
// ---------------------------------------------------------------------------

export interface StudentRecord {
  id: string;
  userId: string;
  admissionNumber: string;
}

export async function createStudent(
  sql: Sql,
  schoolId: string,
  overrides?: { email?: string; firstName?: string; lastName?: string; admissionNumber?: string },
): Promise<StudentRecord> {
  const user = await createUser(sql, schoolId, {
    email: overrides?.email,
    displayName: overrides?.firstName
      ? `${overrides.firstName} ${overrides.lastName ?? "Student"}`
      : undefined,
  });

  const admissionNumber =
    overrides?.admissionNumber ?? `ADM-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
  const firstName = overrides?.firstName ?? "Test";
  const lastName = overrides?.lastName ?? "Student";

  return asAdmin(sql, async (tx) => {
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    await tx.unsafe("SET LOCAL ROLE studafy_app");

    const [student] = await tx<{ id: string; admission_number: string }[]>`
      INSERT INTO app.students (school_id, user_id, admission_number, first_name, last_name, status)
      VALUES (${schoolId}, ${user.id}, ${admissionNumber}, ${firstName}, ${lastName}, 'enrolled')
      RETURNING id, admission_number
    `;

    return { id: student!.id, userId: user.id, admissionNumber: student!.admission_number };
  });
}

// ---------------------------------------------------------------------------
// Teacher
// ---------------------------------------------------------------------------

export interface TeacherRecord {
  id: string;
  userId: string;
  employeeNumber: string;
}

export async function createTeacher(
  sql: Sql,
  schoolId: string,
  overrides?: { email?: string; employeeNumber?: string },
): Promise<TeacherRecord> {
  const user = await createUser(sql, schoolId, { email: overrides?.email });
  const employeeNumber =
    overrides?.employeeNumber ?? `EMP-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;

  return asAdmin(sql, async (tx) => {
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    await tx.unsafe("SET LOCAL ROLE studafy_app");

    const [teacher] = await tx<{ id: string; employee_number: string }[]>`
      INSERT INTO app.teachers (school_id, user_id, employee_number, employment_status)
      VALUES (${schoolId}, ${user.id}, ${employeeNumber}, 'active')
      RETURNING id, employee_number
    `;

    return { id: teacher!.id, userId: user.id, employeeNumber: teacher!.employee_number };
  });
}

// ---------------------------------------------------------------------------
// Academic structure
// ---------------------------------------------------------------------------

export interface AcademicYearRecord {
  id: string;
  code: string;
}

export async function createAcademicYear(
  sql: Sql,
  schoolId: string,
  overrides?: { code?: string; startsOn?: string; endsOn?: string },
): Promise<AcademicYearRecord> {
  const code = overrides?.code ?? `AY-${new Date().getFullYear()}`;

  return asAdmin(sql, async (tx) => {
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    await tx.unsafe("SET LOCAL ROLE studafy_app");

    const [year] = await tx<{ id: string; code: string }[]>`
      INSERT INTO app.academic_years (school_id, code, name, starts_on, ends_on, status)
      VALUES (
        ${schoolId},
        ${code},
        ${`Academic Year ${code}`},
        ${overrides?.startsOn ?? `${new Date().getFullYear()}-01-01`}::date,
        ${overrides?.endsOn ?? `${new Date().getFullYear()}-12-31`}::date,
        'active'
      )
      RETURNING id, code
    `;

    return year!;
  });
}

export interface TermRecord {
  id: string;
  code: string;
}

export async function createTerm(
  sql: Sql,
  schoolId: string,
  academicYearId: string,
  overrides?: { code?: string; sequenceNumber?: number },
): Promise<TermRecord> {
  const code = overrides?.code ?? `TERM-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;

  return asAdmin(sql, async (tx) => {
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    await tx.unsafe("SET LOCAL ROLE studafy_app");

    const [term] = await tx<{ id: string; code: string }[]>`
      INSERT INTO app.terms
        (school_id, academic_year_id, code, name, sequence_number, starts_on, ends_on, status)
      VALUES (
        ${schoolId},
        ${academicYearId},
        ${code},
        ${`Term ${code}`},
        ${overrides?.sequenceNumber ?? 1}::smallint,
        ${`${new Date().getFullYear()}-01-01`}::date,
        ${`${new Date().getFullYear()}-06-30`}::date,
        'active'
      )
      RETURNING id, code
    `;

    return term!;
  });
}

export interface SubjectRecord {
  id: string;
  code: string;
}

export async function createSubject(
  sql: Sql,
  schoolId: string,
  overrides?: { code?: string; name?: string },
): Promise<SubjectRecord> {
  const code = overrides?.code ?? `SUB-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;

  return asAdmin(sql, async (tx) => {
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    await tx.unsafe("SET LOCAL ROLE studafy_app");

    const [subject] = await tx<{ id: string; code: string }[]>`
      INSERT INTO app.subjects (school_id, code, name, status)
      VALUES (${schoolId}, ${code}, ${overrides?.name ?? `Subject ${code}`}, 'active')
      RETURNING id, code
    `;

    return subject!;
  });
}

export interface CourseRecord {
  id: string;
  code: string;
}

export async function createCourse(
  sql: Sql,
  schoolId: string,
  subjectId: string,
  overrides?: { code?: string; name?: string },
): Promise<CourseRecord> {
  const code = overrides?.code ?? `CRS-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;

  return asAdmin(sql, async (tx) => {
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    await tx.unsafe("SET LOCAL ROLE studafy_app");

    const [course] = await tx<{ id: string; code: string }[]>`
      INSERT INTO app.courses (school_id, subject_id, code, name, status)
      VALUES (${schoolId}, ${subjectId}, ${code}, ${overrides?.name ?? `Course ${code}`}, 'active')
      RETURNING id, code
    `;

    return course!;
  });
}

export interface RoomRecord {
  id: string;
  code: string;
}

export async function createRoom(
  sql: Sql,
  schoolId: string,
  overrides?: { code?: string; capacity?: number },
): Promise<RoomRecord> {
  const code = overrides?.code ?? `RM-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;

  return asAdmin(sql, async (tx) => {
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    await tx.unsafe("SET LOCAL ROLE studafy_app");

    const [room] = await tx<{ id: string; code: string }[]>`
      INSERT INTO app.rooms (school_id, code, name, room_type, capacity)
      VALUES (${schoolId}, ${code}, ${`Room ${code}`}, 'physical', ${overrides?.capacity ?? 30})
      RETURNING id, code
    `;

    return room!;
  });
}

export interface ClassRecord {
  id: string;
  code: string;
}

export async function createClass(
  sql: Sql,
  schoolId: string,
  overrides: {
    courseId: string;
    academicYearId: string;
    termId: string;
    leadTeacherId: string;
    roomId: string;
    code?: string;
  },
): Promise<ClassRecord> {
  const code = overrides.code ?? `CLS-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;

  return asAdmin(sql, async (tx) => {
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    await tx.unsafe("SET LOCAL ROLE studafy_app");

    const [cls] = await tx<{ id: string; code: string }[]>`
      INSERT INTO app.classes
        (school_id, course_id, academic_year_id, term_id, lead_teacher_id, room_id, code, capacity, status)
      VALUES (
        ${schoolId},
        ${overrides.courseId},
        ${overrides.academicYearId},
        ${overrides.termId},
        ${overrides.leadTeacherId},
        ${overrides.roomId},
        ${code},
        32,
        'active'
      )
      RETURNING id, code
    `;

    return cls!;
  });
}

export async function createEnrollment(
  sql: Sql,
  schoolId: string,
  classId: string,
  studentId: string,
): Promise<void> {
  await asAdmin(sql, async (tx) => {
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    await tx.unsafe("SET LOCAL ROLE studafy_app");

    await tx`
      INSERT INTO app.enrollments (school_id, class_id, student_id)
      VALUES (${schoolId}, ${classId}, ${studentId})
    `;
  });
}

// ---------------------------------------------------------------------------
// Material
// ---------------------------------------------------------------------------

export interface MaterialRecord {
  id: string;
  title: string;
}

export async function createMaterial(
  sql: Sql,
  schoolId: string,
  overrides: {
    classId: string;
    uploadedByUserId: string;
    title?: string;
    storageKey?: string;
  },
): Promise<MaterialRecord> {
  const title = overrides.title ?? `Material ${crypto.randomUUID().slice(0, 6)}`;
  const storageKey =
    overrides.storageKey ?? `permanent/${schoolId}/test/${crypto.randomUUID().slice(0, 8)}`;

  return asAdmin(sql, async (tx) => {
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    await tx.unsafe("SET LOCAL ROLE studafy_app");

    const [material] = await tx<{ id: string; title: string }[]>`
      INSERT INTO app.materials
        (school_id, class_id, uploaded_by_user_id, last_edited_by_user_id, title,
         storage_key, original_file_name, mime_type, size_bytes)
      VALUES (
        ${schoolId},
        ${overrides.classId},
        ${overrides.uploadedByUserId},
        ${overrides.uploadedByUserId},
        ${title},
        ${storageKey},
        'test.pdf',
        'application/pdf',
        1024
      )
      RETURNING id, title
    `;

    return material!;
  });
}

// ---------------------------------------------------------------------------
// Compound: full tenant with all 7 roles
// ---------------------------------------------------------------------------

export interface TenantUser {
  id: string;
  email: string;
  normalizedEmail: string;
}

export interface TenantFixture {
  schoolId: string;
  schoolSlug: string;
  users: Record<Role, TenantUser>;
  students: StudentRecord[];
  teachers: TeacherRecord[];
  academicYear: AcademicYearRecord;
  term: TermRecord;
  subject: SubjectRecord;
  course: CourseRecord;
  room: RoomRecord;
  cls: ClassRecord;
}

export async function createFullTenant(sql: Sql): Promise<TenantFixture> {
  const roles: Role[] = [
    "SUPER_ADMIN",
    "ORG_ADMIN",
    "INSTRUCTOR",
    "TEACHING_ASSISTANT",
    "STUDENT",
    "GUEST",
    "SUPPORT_AGENT",
  ];

  const school = await createSchool(sql);
  const users: Partial<Record<Role, TenantUser>> = {};

  for (const role of roles) {
    const suffix = role.toLowerCase().replace(/_/g, "-");
    const user = await createUser(sql, school.id, {
      email: `${suffix}@test-${school.slug}.local`,
      displayName: `${role} User`,
    });
    await assignRole(sql, school.id, user.id, role);
    users[role] = user;
  }

  const student = await createStudent(sql, school.id, {
    email: `student@primary.test-${school.slug}.local`,
    firstName: "Primary",
    lastName: "TestStudent",
  });
  const teacher = await createTeacher(sql, school.id, {
    email: `teacher@primary.test-${school.slug}.local`,
  });

  const academicYear = await createAcademicYear(sql, school.id, {
    code: `AY-${school.slug}`,
  });
  const term = await createTerm(sql, school.id, academicYear.id, {
    code: `T1-${school.slug}`,
  });
  const subject = await createSubject(sql, school.id, { code: `SUBJ-${school.slug}` });
  const course = await createCourse(sql, school.id, subject.id, { code: `CRS-${school.slug}` });
  const room = await createRoom(sql, school.id, { code: `RM-${school.slug}` });
  const cls = await createClass(sql, school.id, {
    courseId: course.id,
    academicYearId: academicYear.id,
    termId: term.id,
    leadTeacherId: teacher.id,
    roomId: room.id,
    code: `CLS-${school.slug}`,
  });

  await createEnrollment(sql, school.id, cls.id, student.id);

  return {
    schoolId: school.id,
    schoolSlug: school.slug,
    users: users as Record<Role, TenantUser>,
    students: [student],
    teachers: [teacher],
    academicYear,
    term,
    subject,
    course,
    room,
    cls,
  };
}
