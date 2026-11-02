import { OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES, ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { errorHandlerMiddleware } from "../../../middleware/errorHandler";
import { AUTH_CHANNELS } from "../../auth/channels";
import {
  aiEntitlement,
  fakeEntitlements,
  fakeFeatureService,
  SCHOOL_ID,
  schoolEntitlement,
  silentLogger,
  USER_ID,
  userEntitlement,
} from "../../features/__tests__/fakes";
import { provideFeatures } from "../../features/middleware";
import { AI_ASK_QUESTION_MAX_CHARS } from "../config";

import { AI_PHOTO_MAX_BYTES, aiPhotoTextRoutes } from "./photo-text-routes";

import type { PhotoTextReader } from "./photo-text-routes";
import type { AuthContext } from "../../../middleware/authContext";
import type { AppEnv } from "../../../middleware/requestId";
import type { FakeEntitlements } from "../../features/__tests__/fakes";

const auth: AuthContext = {
  userId: USER_ID,
  schoolId: SCHOOL_ID,
  roles: [ROLES.STUDENT],
  channel: AUTH_CHANNELS.API,
  jti: "jti-1",
  entitlementsVer: 1,
  subscriptionStatus: "active",
};

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

function fakeReader(text: string, read: Uint8Array[] = []): PhotoTextReader {
  return {
    recognize: async (bytes) => {
      read.push(bytes);
      return { text, confidence: 91.6, language: "eng+ara" };
    },
  };
}

const subscribed = () =>
  fakeEntitlements({ school: schoolEntitlement(true), ai: aiEntitlement("active") });

function buildApp(entitlements: FakeEntitlements, reader: PhotoTextReader): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("auth", auth);
    c.set("locale", "en");
    await next();
  });
  app.use("/api/*", provideFeatures(fakeFeatureService({ entitlements })));
  app.route("/", aiPhotoTextRoutes({ reader, redis: null }));
  app.onError(errorHandlerMiddleware(silentLogger));
  return app;
}

const post = (app: OpenAPIHono<AppEnv>, body: Uint8Array, type: string) =>
  app.request("/api/ai/photo-text", { method: "POST", body, headers: { "content-type": type } });

describe("POST /api/ai/photo-text", () => {
  test("returns the photo's text for the student to review", async () => {
    const read: Uint8Array[] = [];
    const app = buildApp(subscribed(), fakeReader("  What is photosynthesis?\n", read));

    const res = await post(app, JPEG, "image/jpeg");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      text: "What is photosynthesis?",
      truncated: false,
      confidence: 92,
    });
    expect(read).toEqual([JPEG]);
  });

  test("reads a PNG as well", async () => {
    const app = buildApp(subscribed(), fakeReader("ما هو التمثيل الضوئي؟"));

    const res = await post(app, PNG, "image/png");

    expect(res.status).toBe(200);
    expect(((await res.json()) as { text: string }).text).toBe("ما هو التمثيل الضوئي؟");
  });

  test("cuts text longer than a question allows and says so", async () => {
    const app = buildApp(subscribed(), fakeReader("a".repeat(AI_ASK_QUESTION_MAX_CHARS + 50)));

    const body = (await (await post(app, JPEG, "image/jpeg")).json()) as {
      text: string;
      truncated: boolean;
    };

    expect(body.text).toHaveLength(AI_ASK_QUESTION_MAX_CHARS);
    expect(body.truncated).toBe(true);
  });

  test("refuses a type other than JPEG or PNG without reading it", async () => {
    const read: Uint8Array[] = [];
    const app = buildApp(subscribed(), fakeReader("x", read));

    const res = await post(app, JPEG, "image/gif");

    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe(
      ERROR_CODES.AI_PHOTO_UNSUPPORTED_TYPE,
    );
    expect(read).toEqual([]);
  });

  test("refuses bytes that are not the image they claim to be", async () => {
    const read: Uint8Array[] = [];
    const app = buildApp(subscribed(), fakeReader("x", read));

    const res = await post(app, new TextEncoder().encode("<svg onload=alert(1)>"), "image/png");

    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe(
      ERROR_CODES.AI_PHOTO_UNSUPPORTED_TYPE,
    );
    expect(read).toEqual([]);
  });

  test("refuses a photo over the size limit", async () => {
    const read: Uint8Array[] = [];
    const app = buildApp(subscribed(), fakeReader("x", read));
    const big = new Uint8Array(AI_PHOTO_MAX_BYTES + 1);
    big.set(JPEG);

    const res = await post(app, big, "image/jpeg");

    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe(ERROR_CODES.AI_PHOTO_TOO_LARGE);
    expect(read).toEqual([]);
  });

  test("answers 402 AI_SUBSCRIPTION_INACTIVE without the Ask AI feature", async () => {
    const read: Uint8Array[] = [];
    const app = buildApp(
      fakeEntitlements({ ai: aiEntitlement("active"), user: userEntitlement({ studentId: null }) }),
      fakeReader("x", read),
    );

    const res = await post(app, JPEG, "image/jpeg");

    expect(res.status).toBe(402);
    expect(((await res.json()) as { code: string }).code).toBe(
      ERROR_CODES.AI_SUBSCRIPTION_INACTIVE,
    );
    expect(read).toEqual([]);
  });
});
