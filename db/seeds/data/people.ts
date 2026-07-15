// Users, their roles, mock OAuth identities, and the student/teacher/parent profiles. Driven entirely
// by MOCK_PERSONAS so the seeded logins are exactly the ones the seeding guide documents. Inserting a
// user with status 'active' fires the 000017 trigger that seeds that user's full notification-preference
// matrix, so this module never writes app.notification_preferences directly.
import { MOCK_OAUTH_PROVIDER, MOCK_PERSONAS, displayName, mockSubject } from "../mock-credentials";
import { seedDate, uuid } from "../support";

import type { MockPersona } from "../mock-credentials";
import type {
  PeopleCtx,
  SchoolCtx,
  SeededPerson,
  SeededStudent,
  SeededTeacher,
  Sql,
} from "../support";

const USERS_CREATED_AT = seedDate(-40, 8);
const USERS_VERIFIED_AT = seedDate(-40, 10);

export async function seedPeople(sql: Sql, school: SchoolCtx): Promise<PeopleCtx> {
  const { schoolId, countryId } = school;

  // Assign a deterministic userId to every persona up front so profiles and relationships can be wired
  // without re-querying.
  const userIdByKey = new Map<string, string>(MOCK_PERSONAS.map((p) => [p.key, uuid()]));

  const userRows = MOCK_PERSONAS.map((persona) => ({
    id: userIdByKey.get(persona.key)!,
    school_id: schoolId,
    email: persona.email,
    normalized_email: persona.email.toLowerCase(),
    display_name: displayName(persona),
    status: "active",
    email_verified_at: USERS_VERIFIED_AT,
    created_at: USERS_CREATED_AT,
  }));
  await sql`
    INSERT INTO app.users ${sql(
      userRows,
      "id",
      "school_id",
      "email",
      "normalized_email",
      "display_name",
      "status",
      "email_verified_at",
      "created_at",
    )}
  `;

  const roleRows = MOCK_PERSONAS.map((persona) => ({
    school_id: schoolId,
    user_id: userIdByKey.get(persona.key)!,
    role: persona.role,
  }));
  await sql`INSERT INTO app.user_roles ${sql(roleRows, "school_id", "user_id", "role")}`;

  const oauthRows = MOCK_PERSONAS.map((persona) => ({
    id: uuid(),
    school_id: schoolId,
    user_id: userIdByKey.get(persona.key)!,
    provider: MOCK_OAUTH_PROVIDER,
    subject: mockSubject(persona),
  }));
  await sql`
    INSERT INTO app.oauth_identities ${sql(oauthRows, "id", "school_id", "user_id", "provider", "subject")}
  `;

  const toPerson = (persona: MockPersona): SeededPerson => ({
    key: persona.key,
    userId: userIdByKey.get(persona.key)!,
    email: persona.email,
    displayName: displayName(persona),
  });

  // Teacher profiles.
  const teacherPersonas = MOCK_PERSONAS.filter((p) => p.group === "teacher");
  const teachers: SeededTeacher[] = teacherPersonas.map((persona) => ({
    ...toPerson(persona),
    teacherId: uuid(),
  }));
  const teacherRows = teacherPersonas.map((persona, index) => ({
    id: teachers[index]!.teacherId,
    school_id: schoolId,
    user_id: teachers[index]!.userId,
    employee_number: `EMP-${String(index + 1).padStart(3, "0")}`,
    employment_status: "active",
    hire_date: "2025-08-15",
  }));
  await sql`
    INSERT INTO app.teachers ${sql(
      teacherRows,
      "id",
      "school_id",
      "user_id",
      "employee_number",
      "employment_status",
      "hire_date",
    )}
  `;

  // Student profiles.
  const studentPersonas = MOCK_PERSONAS.filter((p) => p.group === "student");
  const students: SeededStudent[] = studentPersonas.map((persona, index) => ({
    ...toPerson(persona),
    studentId: uuid(),
    admissionNumber: `STU-${String(index + 1).padStart(4, "0")}`,
    firstName: persona.firstName,
    lastName: persona.lastName,
  }));
  const studentRows = studentPersonas.map((persona, index) => ({
    id: students[index]!.studentId,
    school_id: schoolId,
    user_id: students[index]!.userId,
    admission_number: students[index]!.admissionNumber,
    first_name: persona.firstName,
    last_name: persona.lastName,
    date_of_birth: `2010-0${(index % 9) + 1}-12`,
    nationality_country_id: countryId,
    admission_date: "2025-09-01",
    status: "enrolled",
  }));
  await sql`
    INSERT INTO app.students ${sql(
      studentRows,
      "id",
      "school_id",
      "user_id",
      "admission_number",
      "first_name",
      "last_name",
      "date_of_birth",
      "nationality_country_id",
      "admission_date",
      "status",
    )}
  `;

  const parents: SeededPerson[] = MOCK_PERSONAS.filter((p) => p.group === "parent").map(toPerson);

  // Parent -> child links. Parents carry the GUEST role; the relationship lives here (ST-052 decision).
  const studentIdByKey = new Map<string, string>(
    studentPersonas.map((persona, index) => [persona.key, students[index]!.studentId]),
  );
  const linkRows = MOCK_PERSONAS.flatMap((persona) =>
    (persona.children ?? []).map((child) => ({
      school_id: schoolId,
      parent_user_id: userIdByKey.get(persona.key)!,
      student_id: studentIdByKey.get(child.studentKey)!,
      relationship: child.relationship,
    })),
  );
  if (linkRows.length > 0) {
    await sql`
      INSERT INTO app.parent_child_links ${sql(
        linkRows,
        "school_id",
        "parent_user_id",
        "student_id",
        "relationship",
      )}
    `;
  }

  const superAdmin = toPerson(MOCK_PERSONAS.find((p) => p.role === "SUPER_ADMIN")!);
  const orgAdmin = toPerson(MOCK_PERSONAS.find((p) => p.role === "ORG_ADMIN")!);

  return { superAdmin, orgAdmin, teachers, students, parents };
}
