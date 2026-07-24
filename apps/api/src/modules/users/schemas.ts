import { z } from "@hono/zod-openapi";
import { ROLES } from "@studafy/constants";
import { uuidSchema, dateTimeSchema, dateSchema } from "@studafy/shared-schemas";

import { userStatusSchema } from "../../openapi/components";

// ---------------------------------------------------------------------------
// Role
// ---------------------------------------------------------------------------

const roleValues = Object.values(ROLES) as [string, ...string[]];

export const roleSchema = z.enum(roleValues).openapi({ description: "Predefined platform role." });

// ---------------------------------------------------------------------------
// User with roles
// ---------------------------------------------------------------------------

export const userWithRolesSchema = z
  .object({
    id: uuidSchema.openapi({ description: "Primary key." }),
    school_id: uuidSchema.openapi({ description: "Owning school tenant." }),
    email: z.string().max(320).openapi({
      description: "Contact address as supplied.",
      example: "student@example.edu",
    }),
    display_name: z.string().nullable().openapi({ description: "Optional human-readable name." }),
    status: userStatusSchema,
    roles: z
      .array(roleSchema)
      .openapi({ description: "Roles assigned to this user in the school." }),
    email_verified_at: dateTimeSchema
      .nullable()
      .openapi({ description: "Null until the address is verified." }),
    last_login_at: dateTimeSchema.nullable().openapi({ description: "Null until first login." }),
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
  })
  .openapi("UserWithRoles");

export type UserWithRoles = z.infer<typeof userWithRolesSchema>;

// ---------------------------------------------------------------------------
// Create user
// ---------------------------------------------------------------------------

export const createUserBodySchema = z
  .object({
    email: z.string().email().max(320).openapi({
      description: "Contact address. Unique per school after normalization.",
      example: "newuser@example.edu",
    }),
    display_name: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .openapi({ description: "Optional human-readable name." }),
    role: roleSchema.openapi({ description: "Role to assign to the new user." }),
  })
  .openapi("CreateUserBody");

export type CreateUserBody = z.infer<typeof createUserBodySchema>;

// ---------------------------------------------------------------------------
// Update user
// ---------------------------------------------------------------------------

export const updateUserBodySchema = z
  .object({
    display_name: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .openapi({ description: "Human-readable name." }),
    status: userStatusSchema.optional().openapi({ description: "Lifecycle state." }),
  })
  .openapi("UpdateUserBody");

export type UpdateUserBody = z.infer<typeof updateUserBodySchema>;

// ---------------------------------------------------------------------------
// Update user role
// ---------------------------------------------------------------------------

export const updateUserRoleBodySchema = z
  .object({
    role: roleSchema.openapi({ description: "New role to assign. Replaces the existing role." }),
  })
  .openapi("UpdateUserRoleBody");

export type UpdateUserRoleBody = z.infer<typeof updateUserRoleBodySchema>;

// ---------------------------------------------------------------------------
// List response
// ---------------------------------------------------------------------------

export const userListSchema = z
  .object({
    users: z.array(userWithRolesSchema),
    next_cursor: z.string().nullable().openapi({
      description: "Opaque cursor for the next page. Null when no more results.",
    }),
  })
  .openapi("UserList");

// ---------------------------------------------------------------------------
// Deactivate response
// ---------------------------------------------------------------------------

export const userDeactivateResponseSchema = z
  .object({
    status: z.literal("suspended").openapi({ description: "New user status." }),
    revoked: z.number().int().openapi({ description: "Refresh tokens revoked." }),
    denylisted: z.number().int().openapi({ description: "Access tokens denylisted." }),
    invitations_revoked: z.number().int().openapi({ description: "Pending invitations revoked." }),
  })
  .openapi("UserDeactivateResult");

// ---------------------------------------------------------------------------
// Path params
// ---------------------------------------------------------------------------

export const userIdParamSchema = z
  .object({
    userId: z
      .string()
      .uuid()
      .openapi({
        param: { name: "userId", in: "path" },
        description: "User UUID.",
      }),
  })
  .openapi("UserIdParam");

// ---------------------------------------------------------------------------
// Query params
// ---------------------------------------------------------------------------

export const userListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().min(1).optional(),
    role: roleSchema.optional(),
    status: userStatusSchema.optional(),
    search: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .openapi({ description: "Trigram search over display_name and email." }),
    created_from: z
      .string()
      .datetime()
      .optional()
      .openapi({ description: "Filter by created_at >= this ISO datetime." }),
    created_to: z
      .string()
      .datetime()
      .optional()
      .openapi({ description: "Filter by created_at <= this ISO datetime." }),
  })
  .openapi("UserListQuery");

// ---------------------------------------------------------------------------
// Student
// ---------------------------------------------------------------------------

const studentStatusValues = [
  "applicant",
  "enrolled",
  "suspended",
  "graduated",
  "withdrawn",
  "archived",
] as const;

export const studentStatusSchema = z
  .enum(studentStatusValues)
  .openapi({ description: "Lifecycle state of the student within the school." });

export type StudentStatus = z.infer<typeof studentStatusSchema>;

const parentRelationshipValues = [
  "mother",
  "father",
  "guardian",
  "step_parent",
  "grandparent",
  "sibling",
  "other",
] as const;

export const parentRelationshipSchema = z
  .enum(parentRelationshipValues)
  .openapi({ description: "Guardian relationship to the student." });

// ---------------------------------------------------------------------------
// Student profile (full — admin / finance-visible)
// ---------------------------------------------------------------------------

export const studentProfileSchema = z
  .object({
    id: uuidSchema.openapi({ description: "Primary key." }),
    school_id: uuidSchema.openapi({ description: "Owning school tenant." }),
    user_id: uuidSchema.openapi({ description: "Linked user account." }),
    admission_number: z.string().openapi({
      description: "Unique admission number within the school.",
      example: "ADM-2024-001",
    }),
    first_name: z.string().openapi({ description: "Legal first name." }),
    middle_name: z.string().nullable().openapi({ description: "Middle name, if any." }),
    last_name: z.string().openapi({ description: "Legal last name." }),
    preferred_name: z.string().nullable().openapi({ description: "Preferred or informal name." }),
    date_of_birth: dateSchema.nullable().openapi({ description: "Date of birth (YYYY-MM-DD)." }),
    nationality_country_id: uuidSchema
      .nullable()
      .openapi({ description: "Nationality country FK." }),
    admission_date: dateSchema
      .nullable()
      .openapi({ description: "Date of admission (YYYY-MM-DD)." }),
    status: studentStatusSchema,
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
  })
  .openapi("StudentProfile");

export type StudentProfile = z.infer<typeof studentProfileSchema>;

// ---------------------------------------------------------------------------
// Student demographics (non-finance projection)
// ---------------------------------------------------------------------------

export const studentDemographicsSchema = z
  .object({
    id: uuidSchema.openapi({ description: "Primary key." }),
    school_id: uuidSchema.openapi({ description: "Owning school tenant." }),
    user_id: uuidSchema.openapi({ description: "Linked user account." }),
    first_name: z.string().openapi({ description: "Legal first name." }),
    middle_name: z.string().nullable().openapi({ description: "Middle name, if any." }),
    last_name: z.string().openapi({ description: "Legal last name." }),
    preferred_name: z.string().nullable().openapi({ description: "Preferred or informal name." }),
    date_of_birth: dateSchema.nullable().openapi({ description: "Date of birth (YYYY-MM-DD)." }),
    nationality_country_id: uuidSchema
      .nullable()
      .openapi({ description: "Nationality country FK." }),
    status: studentStatusSchema,
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
  })
  .openapi("StudentDemographics");

export type StudentDemographics = z.infer<typeof studentDemographicsSchema>;

// ---------------------------------------------------------------------------
// Guardian
// ---------------------------------------------------------------------------

export const guardianSchema = z
  .object({
    parent_user_id: uuidSchema.openapi({ description: "Guardian's user ID." }),
    relationship: parentRelationshipSchema,
    created_at: dateTimeSchema,
  })
  .openapi("Guardian");

// ---------------------------------------------------------------------------
// Create student
// ---------------------------------------------------------------------------

export const createStudentBodySchema = z
  .object({
    email: z.string().email().max(320).openapi({
      description: "Contact address. Unique per school after normalization.",
      example: "student@example.edu",
    }),
    admission_number: z.string().min(1).max(100).openapi({
      description: "Unique admission number within the school.",
      example: "ADM-2024-001",
    }),
    first_name: z.string().min(1).max(100).openapi({ description: "Legal first name." }),
    middle_name: z.string().max(100).optional().openapi({ description: "Middle name." }),
    last_name: z.string().min(1).max(100).openapi({ description: "Legal last name." }),
    preferred_name: z
      .string()
      .max(100)
      .optional()
      .openapi({ description: "Preferred or informal name." }),
    date_of_birth: z
      .string()
      .date()
      .optional()
      .openapi({ description: "Date of birth (YYYY-MM-DD)." }),
    nationality_country_id: uuidSchema
      .optional()
      .openapi({ description: "Nationality country FK." }),
    admission_date: z
      .string()
      .date()
      .optional()
      .openapi({ description: "Date of admission (YYYY-MM-DD)." }),
    status: studentStatusSchema.default("applicant"),
    guardians: z
      .array(
        z.object({
          parent_user_id: uuidSchema.openapi({ description: "Guardian's user ID." }),
          relationship: parentRelationshipSchema,
        }),
      )
      .max(10)
      .optional()
      .openapi({ description: "Guardian links to create." }),
  })
  .openapi("CreateStudentBody");

export type CreateStudentBody = z.infer<typeof createStudentBodySchema>;

// ---------------------------------------------------------------------------
// Update student
// ---------------------------------------------------------------------------

export const updateStudentBodySchema = z
  .object({
    first_name: z.string().min(1).max(100).optional().openapi({ description: "Legal first name." }),
    middle_name: z.string().max(100).optional().openapi({ description: "Middle name." }),
    last_name: z.string().min(1).max(100).optional().openapi({ description: "Legal last name." }),
    preferred_name: z
      .string()
      .max(100)
      .optional()
      .openapi({ description: "Preferred or informal name." }),
    date_of_birth: z
      .string()
      .date()
      .optional()
      .openapi({ description: "Date of birth (YYYY-MM-DD)." }),
    nationality_country_id: uuidSchema
      .optional()
      .openapi({ description: "Nationality country FK." }),
    admission_number: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .openapi({ description: "Unique admission number within the school." }),
    admission_date: z
      .string()
      .date()
      .optional()
      .openapi({ description: "Date of admission (YYYY-MM-DD)." }),
    status: studentStatusSchema.optional(),
  })
  .openapi("UpdateStudentBody");

export type UpdateStudentBody = z.infer<typeof updateStudentBodySchema>;

// ---------------------------------------------------------------------------
// Student list
// ---------------------------------------------------------------------------

export const studentListSchema = z
  .object({
    students: z.array(studentProfileSchema),
    next_cursor: z.string().nullable().openapi({
      description: "Opaque cursor for the next page. Null when no more results.",
    }),
  })
  .openapi("StudentList");

// ---------------------------------------------------------------------------
// Student path params
// ---------------------------------------------------------------------------

export const studentIdParamSchema = z
  .object({
    studentId: z
      .string()
      .uuid()
      .openapi({
        param: { name: "studentId", in: "path" },
        description: "Student UUID.",
      }),
  })
  .openapi("StudentIdParam");

// ---------------------------------------------------------------------------
// Student list query
// ---------------------------------------------------------------------------

export const studentListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().min(1).optional(),
    status: studentStatusSchema.optional(),
    search: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .openapi({ description: "Search over first_name, last_name, and admission_number." }),
    created_from: z
      .string()
      .datetime()
      .optional()
      .openapi({ description: "Filter by created_at >= this ISO datetime." }),
    created_to: z
      .string()
      .datetime()
      .optional()
      .openapi({ description: "Filter by created_at <= this ISO datetime." }),
  })
  .openapi("StudentListQuery");

// ---------------------------------------------------------------------------
// Teacher
// ---------------------------------------------------------------------------

const teacherEmploymentStatusValues = [
  "pending",
  "active",
  "on_leave",
  "suspended",
  "terminated",
  "archived",
] as const;

export const teacherEmploymentStatusSchema = z
  .enum(teacherEmploymentStatusValues)
  .openapi({ description: "Employment lifecycle state of the teacher." });

export type TeacherEmploymentStatus = z.infer<typeof teacherEmploymentStatusSchema>;

// ---------------------------------------------------------------------------
// Teacher profile
// ---------------------------------------------------------------------------

export const teacherProfileSchema = z
  .object({
    id: uuidSchema.openapi({ description: "Primary key." }),
    school_id: uuidSchema.openapi({ description: "Owning school tenant." }),
    user_id: uuidSchema.openapi({ description: "Linked user account." }),
    employee_number: z.string().openapi({
      description: "Unique employee number within the school.",
      example: "EMP-2024-001",
    }),
    employment_status: teacherEmploymentStatusSchema,
    hire_date: dateSchema.nullable().openapi({ description: "Date of hire (YYYY-MM-DD)." }),
    termination_date: dateSchema
      .nullable()
      .openapi({ description: "Date of termination (YYYY-MM-DD)." }),
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
  })
  .openapi("TeacherProfile");

export type TeacherProfile = z.infer<typeof teacherProfileSchema>;

// ---------------------------------------------------------------------------
// Create teacher
// ---------------------------------------------------------------------------

export const createTeacherBodySchema = z
  .object({
    email: z.string().email().max(320).openapi({
      description: "Contact address. Unique per school after normalization.",
      example: "teacher@example.edu",
    }),
    employee_number: z.string().min(1).max(100).openapi({
      description: "Unique employee number within the school.",
      example: "EMP-2024-001",
    }),
    employment_status: teacherEmploymentStatusSchema.default("pending"),
    hire_date: z.string().date().optional().openapi({ description: "Date of hire (YYYY-MM-DD)." }),
  })
  .openapi("CreateTeacherBody");

export type CreateTeacherBody = z.infer<typeof createTeacherBodySchema>;

// ---------------------------------------------------------------------------
// Update teacher
// ---------------------------------------------------------------------------

export const updateTeacherBodySchema = z
  .object({
    employee_number: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .openapi({ description: "Unique employee number within the school." }),
    employment_status: teacherEmploymentStatusSchema.optional(),
    hire_date: z.string().date().optional().openapi({ description: "Date of hire (YYYY-MM-DD)." }),
    termination_date: z
      .string()
      .date()
      .optional()
      .openapi({ description: "Date of termination (YYYY-MM-DD)." }),
  })
  .openapi("UpdateTeacherBody");

export type UpdateTeacherBody = z.infer<typeof updateTeacherBodySchema>;

// ---------------------------------------------------------------------------
// Teacher list
// ---------------------------------------------------------------------------

export const teacherListSchema = z
  .object({
    teachers: z.array(teacherProfileSchema),
    next_cursor: z.string().nullable().openapi({
      description: "Opaque cursor for the next page. Null when no more results.",
    }),
  })
  .openapi("TeacherList");

// ---------------------------------------------------------------------------
// Teacher path params
// ---------------------------------------------------------------------------

export const teacherIdParamSchema = z
  .object({
    teacherId: z
      .string()
      .uuid()
      .openapi({
        param: { name: "teacherId", in: "path" },
        description: "Teacher UUID.",
      }),
  })
  .openapi("TeacherIdParam");

// ---------------------------------------------------------------------------
// Teacher list query
// ---------------------------------------------------------------------------

export const teacherListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().min(1).optional(),
    status: teacherEmploymentStatusSchema.optional(),
    search: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .openapi({ description: "Search over employee_number." }),
    created_from: z
      .string()
      .datetime()
      .optional()
      .openapi({ description: "Filter by created_at >= this ISO datetime." }),
    created_to: z
      .string()
      .datetime()
      .optional()
      .openapi({ description: "Filter by created_at <= this ISO datetime." }),
  })
  .openapi("TeacherListQuery");
