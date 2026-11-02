import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES } from "@studafy/constants";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";

import { CodedHttpException } from "../../../coded-http-exception";
import { auditAction } from "../../../middleware/auditEmitter";
import { getLocalizedMessage } from "../../../middleware/locale";
import { rateLimiterMiddleware } from "../../../middleware/rateLimiter";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import { requireFeature } from "../../features/middleware";
import { AI_ASK_QUESTION_MAX_CHARS } from "../config";
import { AI_REFUSAL_CODES } from "../gate/token-budget";

import type { SupportedLocale } from "../../../middleware/locale";
import type { AppEnv } from "../../../middleware/requestId";
import type { RedisClient } from "../../../redis";
import type { Context } from "hono";

/**
 * Ask AI photo text: `POST /api/ai/photo-text`.
 *
 * A student photographs a worksheet or a textbook page; the photo is read with the same Tesseract
 * engine the material ingestion uses (packages/ocr), in memory, and only the recognized text comes
 * back. The client puts that text into the question box, where the student can correct it, and it
 * is then sent like any typed question -- through the question's own length cap, moderation and
 * data-sharing consent. The photo itself is never stored and never reaches the model provider,
 * which is why this route sits outside the consent gate (`isAiModelCallPath`) and the token budget.
 *
 * Gated on the caller's own Ask AI feature (no student id in the path: nothing here reads another
 * person's data, so the subject is simply the caller), and rate limited per user because each
 * request costs real CPU on the API.
 */

/** Largest photo read. A phone photo re-encoded by the app at its reduced quality fits easily. */
export const AI_PHOTO_MAX_BYTES = 5 * 1024 * 1024;

const PHOTO_CONTENT_TYPES = ["image/jpeg", "image/png"] as const;

/** The leading bytes every file of each accepted type starts with. */
const PHOTO_SIGNATURES: Record<(typeof PHOTO_CONTENT_TYPES)[number], readonly number[]> = {
  "image/jpeg": [0xff, 0xd8, 0xff],
  "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
};

function isPhoto(bytes: Uint8Array): boolean {
  return Object.values(PHOTO_SIGNATURES).some((signature) =>
    signature.every((byte, index) => bytes.at(index) === byte),
  );
}

/** What the route needs of an OCR engine; `TesseractOcrEngine` from @studafy/ocr in production. */
export interface PhotoTextReader {
  recognize(
    imageBytes: Uint8Array,
    page: number,
  ): Promise<{ text: string; confidence: number; language: string }>;
}

const photoTextResponseSchema = z.object({
  /** The recognized text, trimmed and cut to the question's length cap. Empty when none was found. */
  text: z.string(),
  /** True when the recognized text was longer than a question allows and was cut. */
  truncated: z.boolean(),
  /** Mean per-word confidence, 0-100. */
  confidence: z.number(),
});

const photoTextRoute = createRoute({
  method: "post",
  path: "/api/ai/photo-text",
  tags: ["AI"],
  operationId: "readAiPhotoText",
  summary: "Read the text in a photo for an Ask AI question",
  description:
    "Recognizes the text in a JPEG or PNG photo (up to 5 MB, the raw image as the request body) " +
    "and returns it for the student to review and send as a question. The photo is read in " +
    "memory and not stored. Requires the Ask AI feature.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: Object.fromEntries(
        PHOTO_CONTENT_TYPES.map((type) => [
          type,
          { schema: z.string().openapi({ type: "string", format: "binary" }) },
        ]),
      ),
    },
  },
  responses: standardResponses(
    { 200: { description: "The text found in the photo", schema: photoTextResponseSchema } },
    [401, 402, 403, 422, 429],
  ),
});

function refuse(c: Context<AppEnv>, code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES]) {
  const locale = (c.get("locale") ?? "en") as SupportedLocale;
  return new CodedHttpException(422, code, getLocalizedMessage(code, locale));
}

export function aiPhotoTextRoutes(deps: {
  reader: PhotoTextReader;
  redis: RedisClient | null;
}): OpenAPIHono<AppEnv> {
  const { reader, redis } = deps;
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // The audit-coverage gate requires every mutating route to declare its audit intent. This POST
  // writes nothing -- the photo is read in memory and only its text is returned -- so it is declared
  // "read" against the Ask AI surface its text feeds, the quiz-grading precedent.
  routes.use("/api/ai/photo-text", auditAction("read", "ai_messages"));
  routes.use(
    "/api/ai/photo-text",
    rateLimiterMiddleware({ redis, routeClass: "ai" }),
    requireFeature("ai_tutor", { codes: AI_REFUSAL_CODES }),
    async (c, next) => {
      const type = c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase();
      if (!PHOTO_CONTENT_TYPES.includes(type as (typeof PHOTO_CONTENT_TYPES)[number])) {
        throw refuse(c, ERROR_CODES.AI_PHOTO_UNSUPPORTED_TYPE);
      }
      await next();
    },
    bodyLimit({
      maxSize: AI_PHOTO_MAX_BYTES,
      onError: (c) => {
        throw refuse(c as Context<AppEnv>, ERROR_CODES.AI_PHOTO_TOO_LARGE);
      },
    }),
  );

  routes.openapi(photoTextRoute, async (c) => {
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    // The declared type is only a claim; the image decoder never sees bytes that are not one.
    if (!isPhoto(bytes)) throw refuse(c, ERROR_CODES.AI_PHOTO_UNSUPPORTED_TYPE);

    const result = await reader.recognize(bytes, 1);
    const text = result.text.trim();
    return c.json(
      {
        text: text.slice(0, AI_ASK_QUESTION_MAX_CHARS),
        truncated: text.length > AI_ASK_QUESTION_MAX_CHARS,
        confidence: Math.round(result.confidence),
      },
      200,
    );
  });

  return routes;
}
