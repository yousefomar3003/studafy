import { z } from "@hono/zod-openapi";

// ---------------------------------------------------------------------------
// Request — provisioning status query
// ---------------------------------------------------------------------------

export const provisioningStatusPathParams = z
  .object({
    schoolId: z
      .string()
      .uuid()
      .openapi({
        param: { name: "schoolId", in: "path" },
        description: "School identifier.",
        example: "d07d5b8e-1c2a-4f3e-9b6a-8c1d2e3f4a5b",
      }),
  })
  .openapi("ProvisioningStatusPathParams");

// ---------------------------------------------------------------------------
// Response — provisioning status
// ---------------------------------------------------------------------------

export const provisioningStatusResponseSchema = z
  .object({
    schoolId: z.string().uuid().openapi({ description: "School identifier." }),
    status: z
      .enum(["pending", "in_progress", "completed", "failed"])
      .openapi({ description: "Current provisioning status." }),
    erpNextSite: z
      .object({
        siteName: z.string().openapi({ description: "ERPNext site hostname." }),
        companyName: z.string().openapi({ description: "ERPNext company name." }),
        status: z
          .enum(["pending", "in_progress", "completed", "failed"])
          .openapi({ description: "ERPNext provisioning status." }),
      })
      .nullable()
      .openapi({ description: "ERPNext site configuration, null if not yet created." }),
  })
  .openapi("ProvisioningStatusResponse");

// ---------------------------------------------------------------------------
// Response — trigger provisioning
// ---------------------------------------------------------------------------

export const triggerProvisioningResponseSchema = z
  .object({
    schoolId: z.string().uuid().openapi({ description: "School identifier." }),
    status: z
      .enum(["pending", "in_progress", "completed", "failed"])
      .openapi({ description: "Provisioning status after trigger." }),
  })
  .openapi("TriggerProvisioningResponse");
