import { createRoute, OpenAPIHono } from "@hono/zod-openapi";

import { clientIpFrom } from "../../lib/client-ip";
import { auditAction } from "../../middleware/auditEmitter";
import { openApiValidationHook } from "../../openapi/hook";
import { standardResponses } from "../../openapi/responses";

import { submitInquiryBodySchema, submitInquiryResponseSchema } from "./schemas";
import { submitInquiry } from "./service";

import type { Database } from "../../db/client";
import type { AppEnv } from "../../middleware/requestId";

const submitInquiryRoute = createRoute({
  method: "post",
  path: "/api/inquiries",
  tags: ["Inquiries"],
  operationId: "submitInquiry",
  summary: 'Send a "Talk to us" inquiry to Studafy',
  description:
    "Public. Records a prospective school's contact details for the Studafy team, who are emailed " +
    "about it and follow it up from the platform console. Protected by Turnstile and rate limiting.",
  security: [],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: submitInquiryBodySchema } },
    },
  },
  responses: standardResponses(
    { 201: { description: "Inquiry received.", schema: submitInquiryResponseSchema } },
    [400, 429, 500],
  ),
});

/**
 * The public "Talk to us" endpoint. Unauthenticated by design (the visitor has no account), so it
 * is listed in jwtAuth.ts's DEFAULT_PUBLIC_PATHS and csrf.ts's exemptions, and rate-limited as
 * `auth-strict` in config/rateLimits.ts.
 */
export function inquiryRoutes(database: Database): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // Records intent only (auditMeta); no audit row is written -- the submission is anonymous and
  // global, so there is no school to audit in. The inquiry row itself is the record.
  routes.use("/api/inquiries", auditAction("insert", "sales_inquiries"));

  routes.openapi(submitInquiryRoute, async (c) => {
    const body = c.req.valid("json");
    const { id } = await submitInquiry(
      { database, captchaSecretKey: process.env.TURNSTILE_SECRET_KEY },
      {
        fullName: body.full_name,
        email: body.email,
        phone: body.phone,
        schoolName: body.school_name,
        jobTitle: body.job_title,
        country: body.country,
        studentCount: body.student_count,
        message: body.message,
        sourcePath: body.source_path,
        captchaToken: body.captcha_token,
        clientIp: clientIpFrom(c),
      },
    );
    c.get("log")?.info(
      { event: "sales_inquiry_received", inquiry_id: id },
      "sales inquiry received",
    );
    return c.json({ message: "Thanks — the Studafy team will be in touch shortly." }, 201);
  });

  return routes;
}
