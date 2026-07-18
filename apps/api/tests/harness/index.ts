export {
  createTestDatabase,
  migrateDatabase,
  integrationEnabled,
  type TestDatabase,
} from "./database";

export {
  createSchool,
  createUser,
  assignRole,
  createStudent,
  createTeacher,
  createAcademicYear,
  createTerm,
  createSubject,
  createCourse,
  createRoom,
  createClass,
  createEnrollment,
  createMaterial,
  createFullTenant,
  type SchoolRecord,
  type UserRecord,
  type StudentRecord,
  type TeacherRecord,
  type AcademicYearRecord,
  type TermRecord,
  type SubjectRecord,
  type CourseRecord,
  type RoomRecord,
  type ClassRecord,
  type MaterialRecord,
  type TenantFixture,
  type TenantUser,
} from "./factories";

export {
  createTestApp,
  authenticatedRequest,
  type TestAuthContext,
  type TestAppOptions,
} from "./request";
