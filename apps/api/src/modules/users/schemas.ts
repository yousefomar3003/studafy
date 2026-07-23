import { z } from "@hono/zod-openapi";
import { ROLES } from "@studafy/constants";
import { uuidSchema, dateTimeSchema } from "@studafy/shared-schemas";

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
