import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

import { requireAuth } from "../../../middleware/authContext";
import { requireChannel } from "../../../middleware/channelGuard";
import { standardResponses } from "../../../openapi/responses";
import { AUTH_CHANNELS } from "../../auth/channels";
import { schoolOffersFeature } from "../../features/license-context";
import { getFeatureService } from "../../features/middleware";
import { getAiOffer } from "../services/ai-offer-service";
import { createAiCheckoutSession } from "../services/checkout-service";

import type { Database } from "../../../db";
import type { AppEnv } from "../../../middleware/requestId";
import type { PaymentProviderRegistry } from "../payment-provider-routing";

const AiCheckoutRequestSchema = z.object({
  priceId: z.string().uuid(),
  studentId: z.string().uuid(),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
});

const AiCheckoutResponseSchema = z.object({
  url: z.string(),
  sessionId: z.string(),
});

const AiOfferSchema = z
  .object({
    price: z
      .object({
        id: z.string().uuid(),
        amountMinor: z.number().int(),
        currency: z.string(),
        interval: z.enum(["monthly", "yearly"]),
      })
      .nullable(),
    students: z.array(
      z
        .object({
          id: z.string().uuid(),
          name: z.string(),
          active: z.boolean(),
          schoolSeat: z.boolean().openapi({
            description:
              "The student holds a seat on the school's license: the school provides their " +
              "paid features, so the add-on is not for sale for them (checkout answers 409).",
          }),
          schoolOffers: z.boolean().openapi({
            description:
              "The school's license sells student seats that include the AI tutor: ask the " +
              "school for a seat rather than buying.",
          }),
        })
        .openapi("AiAddOnOfferStudent"),
    ),
  })
  .openapi("AiAddOnOffer");

const aiOfferRoute = createRoute({
  method: "get",
  path: "/api/subscriptions/ai/offer",
  tags: ["Subscriptions"],
  operationId: "getAiAddOnOffer",
  summary: "What the signed-in user can buy of the AI add-on",
  description:
    "The AI add-on's current price (null until one is set) and the students the caller may buy it " +
    "for: themselves as a student, and the children they are linked to as a parent, each with " +
    "whether the add-on is already active, whether they hold a school-license seat (then it is not " +
    "for sale for them), and whether the school sells a seat that includes it. Web-origin only, " +
    "like the checkout it feeds.",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    { 200: { description: "The offer", schema: AiOfferSchema } },
    [401, 403],
  ),
});

const aiCheckoutRoute = createRoute({
  method: "post",
  path: "/api/subscriptions/ai/checkout",
  tags: ["Subscriptions"],
  operationId: "createAiCheckoutSession",
  summary: "Create an AI subscription checkout session",
  description:
    "Creates a checkout session for a student-level AI add-on, for the student themselves or a " +
    "linked parent (anyone else gets 404). Requires the school to be active, and refuses a " +
    "student holding a school-license seat (409 AI_SUBSCRIPTION_COVERED_BY_SCHOOL). Web-origin only.",
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { "application/json": { schema: AiCheckoutRequestSchema } } },
  },
  responses: standardResponses(
    {
      200: {
        description: "Checkout session created",
        schema: AiCheckoutResponseSchema,
      },
    },
    [400, 401, 403, 404, 409, 502, 503],
  ),
});

export function aiCheckoutRoutes(
  database: Database,
  providers: PaymentProviderRegistry,
): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>();

  app.use("/api/subscriptions/ai/checkout", requireChannel(AUTH_CHANNELS.WEB));
  app.use("/api/subscriptions/ai/offer", requireChannel(AUTH_CHANNELS.WEB));

  app.openapi(aiOfferRoute, async (c) => {
    const auth = requireAuth(c);
    const offer = await getAiOffer(database, {
      schoolId: auth.schoolId,
      userId: auth.userId,
      requestId: c.get("requestId"),
    });
    const features = getFeatureService(c);
    const [license, catalog] = await Promise.all([
      features.licenseContext(
        auth.schoolId,
        offer.students.map((student) => student.userId),
      ),
      features.catalog(),
    ]);
    const offered = schoolOffersFeature(catalog, license.offeredTiers, "ai_tutor");
    return c.json(
      {
        price: offer.price,
        students: offer.students.map((student) => ({
          id: student.id,
          name: student.name,
          active: student.active,
          schoolSeat: (license.seats[student.userId] ?? []).includes("student"),
          schoolOffers: offered,
        })),
      },
      200,
    );
  });

  app.openapi(aiCheckoutRoute, async (c) => {
    const auth = requireAuth(c);
    const body = c.req.valid("json");
    const requestId = c.get("requestId");

    const result = await createAiCheckoutSession(database, providers, {
      schoolId: auth.schoolId,
      priceId: body.priceId,
      studentId: body.studentId,
      successUrl: body.successUrl,
      cancelUrl: body.cancelUrl,
      tenantContext: { schoolId: auth.schoolId, userId: auth.userId, requestId },
    });

    return c.json(result, 200);
  });

  return app;
}
