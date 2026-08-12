import { OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES, ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { errorHandlerMiddleware } from "../../../middleware/errorHandler";
import { openApiValidationHook } from "../../../openapi/hook";
import { AUTH_CHANNELS } from "../../auth/channels";
import { AI_LLM_DEFAULT_LARGE_MODEL, AI_LLM_DEFAULT_SMALL_MODEL } from "../config";
import { LlmProviderError } from "../llm/provider";

import { aiGatewayRoutes } from "./gateway-routes";

import type { Database } from "../../../db/client";
import type { Logger } from "../../../logger";
import type { AuthContext } from "../../../middleware/authContext";
import type { AppEnv } from "../../../middleware/requestId";
import type { AiQuotaHandle } from "../gate/entitlement-gate";
import type { LlmGenerateInput, LlmGeneration, LlmProvider } from "../llm/provider";

const SCHOOL_ID = "00000000-0000-4000-8000-000000000001";
const STUDENT_ID = "00000000-0000-4000-8000-000000000002";
const USER_ID = "00000000-0000-4000-8000-000000000003";

const silentLogger: Logger = {
  level: "info",
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  child: () => silentLogger,
};

const auth: AuthContext = {
  userId: USER_ID,
  schoolId: SCHOOL_ID,
  roles: [ROLES.STUDENT],
  channel: AUTH_CHANNELS.API,
  jti: "jti-1",
  entitlementsVer: 1,
  subscriptionStatus: "active",
};

/** Fake postgres.js Sql: BEGIN + tenant config + the two usage queries, all answered in memory. */
function fakeDatabase() {
  const queries: string[] = [];
  const tx = (..._args: unknown[]) => {
    queries.push("query");
    const result = Promise.resolve([{ id: "sub-1" }]);
    return Object.assign(result, { execute: () => Promise.resolve() });
  };
  // withTenantTx treats a callable Database as itself and an object as a DatabasePools (reading
  // `.primary`), so the fake must be both callable and carry `.begin`.
  const database = Object.assign((() => undefined) as unknown as Database, {
    begin: async (fn: (t: unknown) => Promise<unknown>) => {
      await fn(tx);
    },
  });
  return { database, queries };
}

function quotaHandle(): AiQuotaHandle & { commits: number[] } {
  const commits: number[] = [];
  const handle: AiQuotaHandle = {
    reservationId: "res-1",
    reservedTokens: 1000,
    settled: false,
    async commit(consumed) {
      commits.push(consumed);
      return { settled: true, remaining: 1000 - consumed };
    },
    async release() {
      return { settled: true, remaining: 1000 };
    },
  };
  return Object.assign(handle, { commits });
}

function fakeProvider(opts: { error?: unknown; calls?: LlmGenerateInput[] }): LlmProvider {
  return {
    generate: async (input) => {
      opts.calls?.push(input);
      if (opts.error !== undefined) throw opts.error;
      const generation: LlmGeneration = {
        content: "generated text",
        model: input.model,
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        stopReason: "end_turn",
      };
      return generation;
    },
    stream: () => {
      throw new Error("stream should not be called by the generate route");
    },
  };
}

function buildGatewayApp(
  provider: LlmProvider | null,
  opts: { modelOverrides?: Record<string, string>; handle?: AiQuotaHandle } = {},
): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
  app.use("*", async (c, next) => {
    c.set("auth", auth);
    c.set("locale", "en");
    c.set("aiQuota", opts.handle ?? quotaHandle());
    await next();
  });
  app.route(
    "/",
    aiGatewayRoutes({
      database: fakeDatabase().database,
      provider,
      modelOverrides: opts.modelOverrides,
    }),
  );
  app.onError(errorHandlerMiddleware(silentLogger));
  return app;
}

const generateUrl = `/api/ai/students/${STUDENT_ID}/generate`;

async function postGenerate(
  app: OpenAPIHono<AppEnv>,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.request(generateUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/ai/students/{studentId}/generate", () => {
  test("a null provider answers 503 AI_LLM_DISABLED", async () => {
    const app = buildGatewayApp(null);

    const res = await postGenerate(app, { feature: "ask", prompt: "hello" });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(503);
    expect(body.code).toBe(ERROR_CODES.AI_LLM_DISABLED);
  });

  test("routes to the feature's tier, returns usage, and commits the actual tokens", async () => {
    const calls: LlmGenerateInput[] = [];
    const handle = quotaHandle();
    const { database, queries } = fakeDatabase();
    const app = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
    app.use("*", async (c, next) => {
      c.set("auth", auth);
      c.set("locale", "en");
      c.set("aiQuota", handle);
      await next();
    });
    app.route("/", aiGatewayRoutes({ database, provider: fakeProvider({ calls }) }));
    app.onError(errorHandlerMiddleware(silentLogger));

    const res = await postGenerate(app, {
      feature: "ask",
      prompt: "hello",
      maxTokens: 512,
    });
    const body = (await res.json()) as {
      content: string;
      model: string;
      tier: string;
      feature: string;
      usage: { inputTokens: number; outputTokens: number; totalTokens: number };
    };

    expect(res.status).toBe(200);
    expect(body.content).toBe("generated text");
    expect(body.model).toBe(AI_LLM_DEFAULT_LARGE_MODEL);
    expect(body.tier).toBe("large");
    expect(body.feature).toBe("ask");
    expect(body.usage).toEqual({ inputTokens: 10, outputTokens: 20, totalTokens: 30 });

    // The provider was asked for the routed model, the caller's maxTokens, and the breaker key.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      model: AI_LLM_DEFAULT_LARGE_MODEL,
      prompt: "hello",
      maxTokens: 512,
      userId: USER_ID,
      circuitKey: SCHOOL_ID,
    });

    // The actual provider-reported usage (input + output) was committed, and the durable ledger
    // ran inside the tenant transaction (BEGIN + tenant config + subscription select + upsert).
    expect(handle.commits).toEqual([30]);
    expect(queries.length).toBe(3);
  });

  test("summary routes to the small tier", async () => {
    const calls: LlmGenerateInput[] = [];
    const app = buildGatewayApp(fakeProvider({ calls }));

    const res = await postGenerate(app, { feature: "summary", prompt: "summarize this" });
    const body = (await res.json()) as { model: string; tier: string };

    expect(res.status).toBe(200);
    expect(body.tier).toBe("small");
    expect(body.model).toBe(AI_LLM_DEFAULT_SMALL_MODEL);
    expect(calls[0]!.model).toBe(AI_LLM_DEFAULT_SMALL_MODEL);
  });

  test("model overrides replace the tier's model id", async () => {
    const calls: LlmGenerateInput[] = [];
    const app = buildGatewayApp(fakeProvider({ calls }), {
      modelOverrides: { large: "claude-sonnet-custom" },
    });

    const res = await postGenerate(app, { feature: "exam", prompt: "explain" });
    const body = (await res.json()) as { model: string; tier: string };

    expect(res.status).toBe(200);
    expect(body.tier).toBe("large");
    expect(body.model).toBe("claude-sonnet-custom");
    expect(calls[0]!.model).toBe("claude-sonnet-custom");
  });

  test("a provider 4xx answers 503 AI_LLM_REQUEST_REJECTED without Retry-After", async () => {
    const provider = fakeProvider({
      error: new LlmProviderError("prompt violates content policy", 400, "http", {
        error: { message: "prompt violates content policy" },
      }),
    });
    const app = buildGatewayApp(provider);

    const res = await postGenerate(app, { feature: "ask", prompt: "hello" });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(503);
    expect(body.code).toBe(ERROR_CODES.AI_LLM_REQUEST_REJECTED);
    expect(res.headers.get("Retry-After")).toBeNull();
  });

  test("a provider timeout answers 503 AI_LLM_UNAVAILABLE with Retry-After", async () => {
    const provider = fakeProvider({
      error: new LlmProviderError("timed out", 504, "timeout"),
    });
    const app = buildGatewayApp(provider);

    const res = await postGenerate(app, { feature: "ask", prompt: "hello" });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(503);
    expect(body.code).toBe(ERROR_CODES.AI_LLM_UNAVAILABLE);
    expect(res.headers.get("Retry-After")).toBe("30");
  });

  test("a 5xx provider failure answers 503 AI_LLM_UNAVAILABLE with Retry-After", async () => {
    const provider = fakeProvider({
      error: new LlmProviderError("provider overloaded", 529, "http"),
    });
    const app = buildGatewayApp(provider);

    const res = await postGenerate(app, { feature: "ask", prompt: "hello" });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(503);
    expect(body.code).toBe(ERROR_CODES.AI_LLM_UNAVAILABLE);
    expect(res.headers.get("Retry-After")).toBe("30");
  });

  test("rejects an unknown feature with 400", async () => {
    const app = buildGatewayApp(fakeProvider({}));

    const res = await postGenerate(app, { feature: "horoscope", prompt: "hello" });
    expect(res.status).toBe(400);
  });

  test("rejects a blank or over-length prompt with 400", async () => {
    const app = buildGatewayApp(fakeProvider({}));

    const blank = await postGenerate(app, { feature: "ask", prompt: "   " });
    expect(blank.status).toBe(400);

    const tooLong = await postGenerate(app, {
      feature: "ask",
      prompt: "x".repeat(8001),
    });
    expect(tooLong.status).toBe(400);
  });

  test("rejects an out-of-range maxTokens with 400", async () => {
    const app = buildGatewayApp(fakeProvider({}));

    const zero = await postGenerate(app, { feature: "ask", prompt: "hello", maxTokens: 0 });
    expect(zero.status).toBe(400);

    const huge = await postGenerate(app, {
      feature: "ask",
      prompt: "hello",
      maxTokens: 16_385,
    });
    expect(huge.status).toBe(400);
  });
});
