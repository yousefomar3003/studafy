// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { createApp } from "./app";
import { createInflightTracker } from "./lifecycle";
import { createLogger } from "./logger";

import type { LlmProvider } from "./modules/ai";

const buildApp = (isReady: () => boolean, aiLlmProvider?: LlmProvider | null) =>
  createApp({
    isReady,
    tracker: createInflightTracker(),
    logger: createLogger({ destination: () => undefined }),
    aiLlmProvider,
  });

describe("health routes", () => {
  test("GET /healthz returns 200 ok", async () => {
    const res = await buildApp(() => true).request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test("GET /healthz returns 200 even when the app is not ready (liveness never consults dependencies)", async () => {
    const res = await buildApp(() => false).request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test("GET /readyz returns 200 ready when the app is ready", async () => {
    const res = await buildApp(() => true).request("/readyz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ready" });
  });

  test("GET /readyz returns 503 shutting_down when the app is not ready", async () => {
    const res = await buildApp(() => false).request("/readyz");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "shutting_down" });
  });

  test("GET /api/ai/health reports enabled: false when AI_LLM_ENABLED is off (no provider injected)", async () => {
    const res = await buildApp(() => true).request("/api/ai/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", enabled: false });
  });

  test("GET /api/ai/health reports enabled: true when a provider is injected", async () => {
    const fakeProvider: LlmProvider = {
      generate: async () => {
        throw new Error("not called by this test");
      },
      // Never actually invoked (this test only asserts /api/ai/health reads the injected
      // provider's presence, not its behavior) — the yield is here only to satisfy
      // AsyncGenerator's type, and this method's own body never runs.
      async *stream() {
        yield { type: "delta", delta: "", text: "" };
        throw new Error("not called by this test");
      },
    };
    const res = await buildApp(() => true, fakeProvider).request("/api/ai/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", enabled: true });
  });

  test("GET /api/ai/health is unauthenticated (reachable with no Authorization header)", async () => {
    const res = await buildApp(() => true).request("/api/ai/health", { headers: {} });
    expect(res.status).toBe(200);
  });
});
