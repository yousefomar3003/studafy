import { z } from "@hono/zod-openapi";
import { dateTimeSchema, uuidSchema } from "@studafy/shared-schemas";

import { parentRelationshipSchema } from "../schemas";

export const familyIdParamSchema = z
  .object({
    familyId: uuidSchema.openapi({
      param: { name: "familyId", in: "path" },
      description: "Household UUID.",
    }),
  })
  .openapi("FamilyIdParam");

export const familyLinkParamSchema = familyIdParamSchema
  .extend({
    parentUserId: uuidSchema.openapi({
      param: { name: "parentUserId", in: "path" },
      description: "Parent user UUID.",
    }),
    studentId: uuidSchema.openapi({
      param: { name: "studentId", in: "path" },
      description: "Student UUID.",
    }),
  })
  .openapi("FamilyLinkParam");

export const familyListQuerySchema = z
  .object({
    search: z.string().trim().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .openapi("FamilyListQuery");

export const familyLinkSchema = z
  .object({
    family_id: uuidSchema,
    parent_user_id: uuidSchema,
    student_id: uuidSchema,
    relationship: parentRelationshipSchema,
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
  })
  .openapi("FamilyLink");

export const familySchema = z
  .object({
    id: uuidSchema,
    school_id: uuidSchema,
    display_name: z.string(),
    primary_parent_user_id: uuidSchema,
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
  })
  .openapi("Family");

export const familyDetailSchema = familySchema
  .extend({ links: z.array(familyLinkSchema) })
  .openapi("FamilyDetail");

export const familyListSchema = z
  .object({ families: z.array(familySchema), total: z.number().int() })
  .openapi("FamilyList");

export const createFamilyBodySchema = z
  .object({
    display_name: z.string().trim().min(1).max(200),
    primary_parent_user_id: uuidSchema,
  })
  .openapi("CreateFamilyBody");

export const updateFamilyBodySchema = z
  .object({
    display_name: z.string().trim().min(1).max(200).optional(),
    primary_parent_user_id: uuidSchema.optional(),
  })
  .refine(
    (value) => value.display_name !== undefined || value.primary_parent_user_id !== undefined,
    {
      message: "At least one field is required",
    },
  )
  .openapi("UpdateFamilyBody");

export const createFamilyLinkBodySchema = z
  .object({
    parent_user_id: uuidSchema,
    student_id: uuidSchema,
    relationship: parentRelationshipSchema,
  })
  .openapi("CreateFamilyLinkBody");

export const updateFamilyLinkBodySchema = z
  .object({
    target_family_id: uuidSchema.optional(),
    relationship: parentRelationshipSchema.optional(),
  })
  .refine((value) => value.target_family_id !== undefined || value.relationship !== undefined, {
    message: "At least one field is required",
  })
  .openapi("UpdateFamilyLinkBody");
