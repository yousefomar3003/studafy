import { z } from "@hono/zod-openapi";
import { uuidSchema, dateTimeSchema } from "@studafy/shared-schemas";

export const disciplineIncidentTypeSchema = z
  .enum([
    "behavioral",
    "academic_integrity",
    "attendance",
    "bullying",
    "substance",
    "vandalism",
    "safety",
    "other",
  ])
  .openapi({ description: "Category of the incident." });

export type DisciplineIncidentType = z.infer<typeof disciplineIncidentTypeSchema>;

export const disciplineSeveritySchema = z
  .enum(["minor", "moderate", "major", "critical"])
  .openapi({ description: "Severity level of the incident." });

export type DisciplineSeverity = z.infer<typeof disciplineSeveritySchema>;

export const disciplineIncidentStatusSchema = z
  .enum(["reported", "under_review", "resolved", "escalated", "closed"])
  .openapi({ description: "Lifecycle state of the incident." });

export type DisciplineIncidentStatus = z.infer<typeof disciplineIncidentStatusSchema>;

export const disciplineActionTypeSchema = z
  .enum([
    "verbal_warning",
    "written_warning",
    "detention",
    "in_school_suspension",
    "out_of_school_suspension",
    "expulsion",
    "parent_meeting",
    "counseling_referral",
    "community_service",
    "other",
  ])
  .openapi({ description: "Type of disciplinary action taken." });

export type DisciplineActionType = z.infer<typeof disciplineActionTypeSchema>;

export const disciplineActionStatusSchema = z
  .enum(["pending", "active", "completed", "revoked"])
  .openapi({ description: "Lifecycle state of the action." });

export type DisciplineActionStatus = z.infer<typeof disciplineActionStatusSchema>;

export const disciplineIncidentSchema = z
  .object({
    id: uuidSchema.openapi({ description: "Primary key." }),
    school_id: uuidSchema.openapi({ description: "Owning school tenant." }),
    student_id: uuidSchema.openapi({ description: "Student involved." }),
    class_id: uuidSchema.nullable().openapi({ description: "Associated class, if any." }),
    reporter_user_id: uuidSchema.openapi({ description: "User who reported the incident." }),
    incident_type: disciplineIncidentTypeSchema,
    severity: disciplineSeveritySchema,
    status: disciplineIncidentStatusSchema,
    title: z.string().openapi({ description: "Incident title." }),
    description: z.string().nullable().openapi({ description: "Detailed description." }),
    incident_at: z.string().datetime().openapi({ description: "When the incident occurred." }),
    resolved_at: z.string().datetime().nullable().openapi({ description: "When resolved." }),
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
  })
  .openapi("DisciplineIncident");

export type DisciplineIncident = z.infer<typeof disciplineIncidentSchema>;

export const disciplineActionSchema = z
  .object({
    id: uuidSchema.openapi({ description: "Primary key." }),
    school_id: uuidSchema.openapi({ description: "Owning school tenant." }),
    incident_id: uuidSchema.openapi({ description: "Parent incident." }),
    action_type: disciplineActionTypeSchema,
    action_by_user_id: uuidSchema.openapi({ description: "User who issued the action." }),
    status: disciplineActionStatusSchema,
    description: z.string().nullable().openapi({ description: "Action details." }),
    effective_from: z.string().date().nullable().openapi({ description: "Start date." }),
    effective_until: z.string().date().nullable().openapi({ description: "End date." }),
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
  })
  .openapi("DisciplineAction");

export type DisciplineAction = z.infer<typeof disciplineActionSchema>;

export const createIncidentBodySchema = z
  .object({
    student_id: uuidSchema.openapi({ description: "Student involved." }),
    class_id: uuidSchema.optional().openapi({ description: "Associated class, if any." }),
    incident_type: disciplineIncidentTypeSchema,
    severity: disciplineSeveritySchema,
    title: z.string().min(1).openapi({ description: "Incident title." }),
    description: z.string().optional().openapi({ description: "Detailed description." }),
    incident_at: z.string().datetime().openapi({ description: "When the incident occurred." }),
  })
  .openapi("CreateIncidentBody");

export type CreateIncidentBody = z.infer<typeof createIncidentBodySchema>;

export const updateIncidentBodySchema = z
  .object({
    severity: disciplineSeveritySchema.optional(),
    status: disciplineIncidentStatusSchema.optional(),
    description: z.string().optional(),
  })
  .openapi("UpdateIncidentBody");

export type UpdateIncidentBody = z.infer<typeof updateIncidentBodySchema>;

export const resolveIncidentBodySchema = z
  .object({
    resolution_description: z.string().optional().openapi({ description: "Resolution notes." }),
  })
  .openapi("ResolveIncidentBody");

export type ResolveIncidentBody = z.infer<typeof resolveIncidentBodySchema>;

export const createActionBodySchema = z
  .object({
    action_type: disciplineActionTypeSchema,
    description: z.string().optional().openapi({ description: "Action details." }),
    effective_from: z.string().date().optional().openapi({ description: "Start date." }),
    effective_until: z.string().date().optional().openapi({ description: "End date." }),
  })
  .openapi("CreateActionBody");

export type CreateActionBody = z.infer<typeof createActionBodySchema>;

export const updateActionBodySchema = z
  .object({
    status: disciplineActionStatusSchema.optional(),
    description: z.string().optional(),
    effective_from: z.string().date().optional(),
    effective_until: z.string().date().optional(),
  })
  .openapi("UpdateActionBody");

export type UpdateActionBody = z.infer<typeof updateActionBodySchema>;

export const disciplineIncidentListSchema = z
  .object({
    incidents: z.array(disciplineIncidentSchema),
    total: z.number().int().openapi({ description: "Total matching records." }),
  })
  .openapi("DisciplineIncidentList");

export const disciplineActionListSchema = z
  .object({
    actions: z.array(disciplineActionSchema),
    total: z.number().int().openapi({ description: "Total matching records." }),
  })
  .openapi("DisciplineActionList");

export const disciplineIncidentQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
    student_id: uuidSchema.optional().openapi({ description: "Filter by student." }),
    class_id: uuidSchema.optional().openapi({ description: "Filter by class." }),
    status: disciplineIncidentStatusSchema.optional().openapi({ description: "Filter by status." }),
    severity: disciplineSeveritySchema.optional().openapi({ description: "Filter by severity." }),
  })
  .openapi("DisciplineIncidentQuery");

export const incidentIdParamSchema = z
  .object({
    incidentId: z
      .string()
      .uuid()
      .openapi({
        param: { name: "incidentId", in: "path" },
        description: "Discipline incident UUID.",
      }),
  })
  .openapi("IncidentIdParam");

export const actionIdParamSchema = z
  .object({
    incidentId: z
      .string()
      .uuid()
      .openapi({
        param: { name: "incidentId", in: "path" },
        description: "Discipline incident UUID.",
      }),
    actionId: z
      .string()
      .uuid()
      .openapi({
        param: { name: "actionId", in: "path" },
        description: "Discipline action UUID.",
      }),
  })
  .openapi("ActionIdParam");
