import { z } from "@hono/zod-openapi";
import { ASSIGNABLE_ROLES, ROLES } from "@studafy/constants";
import { normalizePhoneNumber, PHONE_MAX } from "@studafy/records";
import { uuidSchema, dateTimeSchema, dateSchema } from "@studafy/shared-schemas";

import { userStatusSchema } from "../../openapi/components";
import { recordAnswerInputSchema } from "../records/schemas";

// ---------------------------------------------------------------------------
// Role
// ---------------------------------------------------------------------------

const roleValues = Object.values(ROLES) as [string, ...string[]];

export const roleSchema = z.enum(roleValues).openapi({ description: "Predefined platform role." });

// What a school's user endpoints may assign. SUPER_ADMIN and SUPPORT_AGENT are Studafy staff roles:
// an ORG_ADMIN who could assign them could make themselves SUPER_ADMIN (QA-10, finding F-01).
export const assignableRoleSchema = z.enum(ASSIGNABLE_ROLES).openapi({
  description:
    "A school role. The platform roles SUPER_ADMIN and SUPPORT_AGENT cannot be assigned here.",
});

// ---------------------------------------------------------------------------
// Parent relationship
// ---------------------------------------------------------------------------

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
// Contact phone
// ---------------------------------------------------------------------------

/**
 * A person's contact phone as people type it: digits with + - ( ) . and spaces, 6 to 20 digits,
 * Arabic digits allowed. Saved as normalizePhoneNumber reads it. Never used to match anyone.
 */
export const contactPhoneSchema = z
  .string()
  .max(PHONE_MAX)
  .refine((value) => normalizePhoneNumber(value) !== null, { message: "Not a valid phone number" })
  .openapi({ example: "+965 5000 1234" });

// ---------------------------------------------------------------------------
// User with roles
// ---------------------------------------------------------------------------

export const userWithRolesSchema = z
  .object({
    id: uuidSchema.openapi({ description: "Primary key." }),
    school_id: uuidSchema.openapi({ description: "Owning school tenant." }),
    email: z
      .string()
      .max(320)
      .nullable()
      .openapi({
        description:
          "Contact address as supplied. Null for members who sign in with their member ID and a " +
          "password instead of Google or Microsoft.",
        example: "student@example.edu",
      }),
    display_name: z.string().nullable().openapi({ description: "Optional human-readable name." }),
    phone: z.string().nullable().openapi({
      description: "Contact phone as the school entered it. Null when none was given.",
    }),
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
    email: z
      .string()
      .email()
      .max(320)
      .optional()
      .openapi({
        description:
          "Contact address. Unique per school after normalization. " +
          "Optional for students, parents, teachers and attendance officers, who sign in with their member ID and a password. Required for every other role.",
        example: "newuser@example.edu",
      }),
    display_name: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .openapi({ description: "Human-readable name.", example: "Jamie Rivera" }),
    phone: contactPhoneSchema.optional(),
    role: assignableRoleSchema.openapi({ description: "Role to assign to the new user." }),
    children: z
      .array(
        z
          .object({
            student_id: uuidSchema.openapi({ description: "Student to link the new parent to." }),
            relationship: parentRelationshipSchema,
          })
          .openapi("CreateUserChild"),
      )
      .min(1)
      .max(20)
      .optional()
      .openapi({
        description:
          "PARENT only: students to link the new parent to, in the same transaction. Each link " +
          "joins the parent's household (created on the first link). Requires `parent:link` " +
          "on top of `user:create`; without it a request carrying children is refused with 403.",
      }),
    records: z
      .array(recordAnswerInputSchema)
      .max(200)
      .optional()
      .openapi({
        description:
          "PARENT only: answers to the school's published parent record form, written in the " +
          "same transaction. Requires `studentRecord:update` on top of `user:create`.",
      }),
  })
  .refine((body) => !body.records || body.role === "PARENT", {
    message: "Only a PARENT user has a parent record",
    path: ["records"],
  })
  .refine((body) => !body.children || body.role === "PARENT", {
    message: "Only a PARENT user can be linked to children",
    path: ["children"],
  })
  .refine(
    (body) =>
      !body.children ||
      new Set(body.children.map((child) => child.student_id)).size === body.children.length,
    { message: "Each student can be listed once", path: ["children"] },
  )
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
    phone: contactPhoneSchema
      .nullable()
      .optional()
      .openapi({ description: "Contact phone. Null removes it; omitted leaves it as it is." }),
    status: userStatusSchema.optional().openapi({ description: "Lifecycle state." }),
  })
  .openapi("UpdateUserBody");

export type UpdateUserBody = z.infer<typeof updateUserBodySchema>;

// ---------------------------------------------------------------------------
// Update user role
// ---------------------------------------------------------------------------

export const updateUserRoleBodySchema = z
  .object({
    role: assignableRoleSchema.openapi({
      description: "New role to assign. Replaces the existing role.",
    }),
  })
  .openapi("UpdateUserRoleBody");

export type UpdateUserRoleBody = z.infer<typeof updateUserRoleBodySchema>;

// ---------------------------------------------------------------------------
// List response
// ---------------------------------------------------------------------------

export const userListItemSchema = userWithRolesSchema
  .extend({
    member_codes: z.array(z.string()).openapi({
      description:
        "Platform-issued member IDs, one per student/teacher/parent role held (e.g. STU-100001).",
    }),
  })
  .openapi("UserListItem");

export type UserListItem = z.infer<typeof userListItemSchema>;

export const userListSchema = z
  .object({
    users: z.array(userListItemSchema),
    next_cursor: z.string().nullable().openapi({
      description: "Opaque cursor for the next page. Null when no more results.",
    }),
  })
  .openapi("UserList");

// ---------------------------------------------------------------------------
// Status counts
// ---------------------------------------------------------------------------

export const userStatusCountsSchema = z
  .object({
    invited: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    suspended: z.number().int().nonnegative(),
    archived: z.number().int().nonnegative(),
  })
  .openapi("UserStatusCounts");

// ---------------------------------------------------------------------------
// Member summary
// ---------------------------------------------------------------------------

export const userMemberSummarySchema = z
  .object({
    school_number: z.number().int().positive().openapi({
      description: "The school's platform number; the leading digits of its member IDs.",
    }),
    students: z.number().int().nonnegative(),
    teachers: z.number().int().nonnegative(),
    parents: z.number().int().nonnegative(),
    attendance_officers: z.number().int().nonnegative(),
  })
  .openapi("UserMemberSummary");

// ---------------------------------------------------------------------------
// Setup codes (QA-11)
// ---------------------------------------------------------------------------

const setupCodeField = z.string().openapi({
  description:
    "One-time code the member signs in with to choose their password. Shown only in this " +
    "response; it cannot be retrieved again.",
  example: "7K3M-Q9TZ-2HXR-B8WD",
});

const setupCodeExpiresField = z.string().datetime().openapi({
  description: "When the setup code stops working.",
});

export const memberSetupCodeSchema = z
  .object({
    usernames: z.array(z.string()).openapi({ description: "The member IDs they sign in with." }),
    setup_code: setupCodeField,
    expires_at: setupCodeExpiresField,
  })
  .openapi("MemberSetupCode");

export const issueSetupCodesBodySchema = z
  .object({
    role: z.enum(["STUDENT", "INSTRUCTOR", "PARENT", "ATTENDANCE_OFFICER"]).openapi({
      description: "Which members to issue codes to.",
    }),
    include_pending: z
      .boolean()
      .optional()
      .openapi({
        description:
          "Also re-issue to members whose earlier code is unused and unexpired (a reprint). Their " +
          "earlier code stops working. Page with `after`.",
      }),
    after: z.string().trim().min(1).max(40).optional().openapi({
      description: "Only members whose member ID sorts after this one: the previous `last`.",
    }),
  })
  .openapi("IssueMemberSetupCodesRequest");

export const issuedSetupCodeSchema = z
  .object({
    user_id: z.string().uuid(),
    display_name: z.string().nullable(),
    usernames: z.array(z.string()),
    setup_code: setupCodeField,
    expires_at: setupCodeExpiresField,
    class_label: z
      .string()
      .nullable()
      .openapi({
        description:
          'A student\'s grade and section this academic year ("Grade 1 – A"), for sorting and ' +
          "labelling login slips. Null for other roles or an unplaced student.",
      }),
    children: z.array(z.string()).openapi({
      description: "A parent's linked children, by name, so a slip can go home with them.",
    }),
  })
  .openapi("IssuedMemberSetupCode");

export const issuedSetupCodesSchema = z
  .object({
    issued: z.array(issuedSetupCodeSchema),
    remaining: z.number().int().nonnegative().openapi({
      description: "Members still waiting for a code; call again to issue the next batch.",
    }),
    last: z.string().nullable().openapi({
      description: "The last member ID of this batch; send it as `after` for the next batch.",
    }),
  })
  .openapi("IssuedMemberSetupCodes");

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
// Student self (GET /api/students/me)
// ---------------------------------------------------------------------------

export const studentSelfSchema = z
  .object({
    id: uuidSchema.openapi({ description: "The caller's own student record id." }),
    school_id: uuidSchema.openapi({ description: "Owning school tenant." }),
    user_id: uuidSchema.openapi({ description: "Linked user account (the caller)." }),
    first_name: z.string().openapi({ description: "Legal first name." }),
    last_name: z.string().openapi({ description: "Legal last name." }),
    preferred_name: z.string().nullable().openapi({ description: "Preferred or informal name." }),
    status: studentStatusSchema,
    enrolled_class_ids: z.array(uuidSchema).openapi({
      description:
        "Ids of the active classes the student is actively enrolled in, sorted ascending. " +
        "Empty when the student has no current enrollments.",
    }),
  })
  .openapi("StudentSelf");

export type StudentSelf = z.infer<typeof studentSelfSchema>;

// ---------------------------------------------------------------------------
// Guardian
// ---------------------------------------------------------------------------

export const guardianSchema = z
  .object({
    family_id: uuidSchema.openapi({ description: "Household that owns this guardian link." }),
    parent_user_id: uuidSchema.openapi({ description: "Guardian's user ID." }),
    relationship: parentRelationshipSchema,
    created_at: dateTimeSchema,
  })
  .openapi("Guardian");

// ---------------------------------------------------------------------------
// Link guardian
// ---------------------------------------------------------------------------

export const linkGuardianBodySchema = z
  .object({
    family_id: uuidSchema.optional().openapi({
      description:
        "Existing household UUID. When omitted, the parent's oldest household is reused or created.",
    }),
    parent_user_id: uuidSchema.openapi({
      description: "User ID of the parent to link. Must have the PARENT role.",
    }),
    relationship: parentRelationshipSchema,
  })
  .openapi("LinkGuardianBody");

export type LinkGuardianBody = z.infer<typeof linkGuardianBodySchema>;

// ---------------------------------------------------------------------------
// Unlink guardian path params
// ---------------------------------------------------------------------------

export const guardianParamSchema = z
  .object({
    studentId: z
      .string()
      .uuid()
      .openapi({
        param: { name: "studentId", in: "path" },
        description: "Student UUID.",
      }),
    userId: z
      .string()
      .uuid()
      .openapi({
        param: { name: "userId", in: "path" },
        description: "Parent user UUID.",
      }),
  })
  .openapi("GuardianParam");

// ---------------------------------------------------------------------------
// Create student
// ---------------------------------------------------------------------------

export const createStudentBodySchema = z
  .object({
    email: z
      .string()
      .email()
      .max(320)
      .optional()
      .openapi({
        description:
          "Contact address. Unique per school after normalization. Optional: students sign in with " +
          "their member ID and a password.",
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
          family_id: uuidSchema.optional().openapi({
            description:
              "Existing household UUID. When omitted, the guardian's oldest household is reused or created.",
          }),
          parent_user_id: uuidSchema.openapi({ description: "Guardian's user ID." }),
          relationship: parentRelationshipSchema,
        }),
      )
      .max(10)
      .optional()
      .openapi({
        description:
          "Guardian links to create in the same transaction. Requires `parent:link` on top of " +
          "`student:create`; without it a request carrying guardians is refused with 403.",
      }),
    records: z
      .array(recordAnswerInputSchema)
      .max(200)
      .optional()
      .openapi({
        description:
          "Answers to the school's published student record form, written in the same " +
          "transaction. Requires `studentRecord:update` on top of `student:create`. Missing " +
          "required fields never block creation.",
      }),
  })
  .refine(
    (body) =>
      !body.guardians ||
      new Set(body.guardians.map((guardian) => guardian.parent_user_id)).size ===
        body.guardians.length,
    { message: "Each guardian can be listed once", path: ["guardians"] },
  )
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
    email: z
      .string()
      .email()
      .max(320)
      .optional()
      .openapi({
        description:
          "Contact address. Unique per school after normalization. Optional: teachers sign in with " +
          "their member ID and a password.",
        example: "teacher@example.edu",
      }),
    display_name: z.string().trim().min(1).max(200).optional().openapi({
      description: "The teacher's name. Defaults to the email, or the employee number.",
    }),
    phone: contactPhoneSchema.optional().openapi({
      description:
        "The teacher's contact phone, shown to staff who manage users. Required by the Teachers " +
        "import template.",
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
