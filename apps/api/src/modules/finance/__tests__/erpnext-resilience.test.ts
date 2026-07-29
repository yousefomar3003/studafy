// Resilience and secret-handling for the ERPNext client (ST-119). No database: every case here is
// about what the client does with a response, so `fetch` is stubbed and the assertions are about
// retries, classification, and what does *not* appear in an error.

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test, beforeEach, afterAll } from "bun:test";

import {
  CircuitOpenError,
  InMemoryCircuitBreaker,
  DEFAULT_FAILURE_THRESHOLD,
} from "../../../erpnext/circuit-breaker";
import { ErpNextClient, ErpNextError, isTransientErpNextFailure } from "../../../erpnext/client";
import { formatMinorUnits, fromMinorUnits, toMinorUnits } from "../currency";

import type { Logger } from "../../../logger";

const API_KEY = "super-secret-key:and-its-secret-half";

const originalFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = originalFetch;
});

interface StubResponse {
  status: number;
  body?: unknown;
  /** Throw instead of responding, to simulate a transport failure. */
  throws?: Error;
}

let calls: { url: string; init: RequestInit }[] = [];

function stubFetch(responses: StubResponse[]): void {
  let index = 0;
  globalThis.fetch = (async (url: string | URL | Request, init: RequestInit) => {
    calls.push({ url: String(url), init });
    const spec = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    if (spec.throws) throw spec.throws;
    return new Response(JSON.stringify(spec.body ?? {}), {
      status: spec.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof globalThis.fetch;
}

const captured: { level: string; payload: unknown }[] = [];

const captureLogger = {
  child: () => captureLogger,
  debug: (payload: unknown) => captured.push({ level: "debug", payload }),
  info: (payload: unknown) => captured.push({ level: "info", payload }),
  warn: (payload: unknown) => captured.push({ level: "warn", payload }),
  error: (payload: unknown) => captured.push({ level: "error", payload }),
  fatal: (payload: unknown) => captured.push({ level: "fatal", payload }),
} as unknown as Logger;

/** No real sleeping: the retry policy is what is under test, not the wall clock. */
const noSleep = async (): Promise<void> => undefined;

function makeClient(overrides: Partial<ConstructorParameters<typeof ErpNextClient>[0]> = {}) {
  return new ErpNextClient({
    baseUrl: "https://erp.test",
    apiKey: API_KEY,
    logger: captureLogger,
    sleep: noSleep,
    ...overrides,
  });
}

beforeEach(() => {
  calls = [];
  captured.length = 0;
});

describe("failure classification", () => {
  test("a timed-out request reports kind 'timeout' and 504, not a flattened 500", async () => {
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    stubFetch([{ status: 0, throws: abort }]);

    const error = (await makeClient()
      .get("/api/resource/Fee%20Structure")
      .catch((e) => e)) as ErpNextError;

    expect(error).toBeInstanceOf(ErpNextError);
    expect(error.kind).toBe("timeout");
    expect(error.status).toBe(504);
  });

  test("a transport failure reports kind 'network' and 503", async () => {
    stubFetch([{ status: 0, throws: new TypeError("fetch failed") }]);

    const error = (await makeClient()
      .get("/x")
      .catch((e) => e)) as ErpNextError;

    expect(error.kind).toBe("network");
    expect(error.status).toBe(503);
  });

  test("an ERPNext rejection keeps its own status and message", async () => {
    stubFetch([{ status: 417, body: { message: "Total does not match components" } }]);

    const error = (await makeClient()
      .post("/x", {})
      .catch((e) => e)) as ErpNextError;

    expect(error.kind).toBe("http");
    expect(error.status).toBe(417);
    expect(error.message).toBe("Total does not match components");
  });
});

describe("retry policy", () => {
  test("retries a 503 up to the attempt limit, then gives up", async () => {
    stubFetch([{ status: 503, body: { message: "down" } }]);

    await expect(makeClient().get("/x")).rejects.toThrow();

    expect(calls).toHaveLength(3);
  });

  test("does not retry a 400 — it is ERPNext's verdict, not a blip", async () => {
    stubFetch([{ status: 400, body: { message: "Fee category is required" } }]);

    await expect(makeClient().post("/x", {})).rejects.toThrow("Fee category is required");

    expect(calls).toHaveLength(1);
  });

  test("stops retrying as soon as an attempt succeeds", async () => {
    stubFetch([
      { status: 503, body: { message: "warming up" } },
      { status: 200, body: { data: { name: "FS-0001" } } },
    ]);

    const response = await makeClient().get<{ data: { name: string } }>("/x");

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  test("classifies 429 and 5xx as transient, 4xx as not", () => {
    expect(isTransientErpNextFailure(new ErpNextError("", 429, null, "http"))).toBe(true);
    expect(isTransientErpNextFailure(new ErpNextError("", 500, null, "http"))).toBe(true);
    expect(isTransientErpNextFailure(new ErpNextError("", 0, null, "timeout"))).toBe(true);
    expect(isTransientErpNextFailure(new ErpNextError("", 400, null, "http"))).toBe(false);
    expect(isTransientErpNextFailure(new CircuitOpenError("school"))).toBe(false);
  });
});

describe("header forwarding", () => {
  test("forwards Accept-Language so ERPNext answers in the caller's language", async () => {
    stubFetch([{ status: 200, body: { data: {} } }]);

    await makeClient().get("/x", { acceptLanguage: "ar" });

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Accept-Language"]).toBe("ar");
  });
});

describe("secret handling", () => {
  test("the API key never reaches the error message, payload, or the log", async () => {
    // ERPNext echoes request context into some error bodies; this simulates the worst case, where
    // the credential itself comes back inside the failure.
    stubFetch([
      {
        status: 500,
        body: {
          message: `Auth failed for token ${API_KEY}`,
          api_key: API_KEY,
          nested: { echoed_authorization: `token ${API_KEY}` },
        },
      },
    ]);

    const error = (await makeClient()
      .get("/x")
      .catch((e) => e)) as ErpNextError;

    const serialized = JSON.stringify({
      message: error.message,
      data: error.data,
      logs: captured,
    });

    expect(serialized).not.toContain(API_KEY);
    // The retry warnings did fire, so this is not passing by virtue of nothing being logged.
    expect(captured.length).toBeGreaterThan(0);
    expect(error.message).toContain("[REDACTED]");
  });

  test("key-named fields are redacted even when the value is unrelated", async () => {
    stubFetch([{ status: 400, body: { message: "nope", api_key: "some-other-value" } }]);

    const error = (await makeClient()
      .post("/x", {})
      .catch((e) => e)) as ErpNextError;

    expect((error.data as Record<string, unknown>).api_key).toBe("[REDACTED]");
  });
});

describe("circuit breaker", () => {
  test("opens after the threshold and then rejects without calling through", async () => {
    const breaker = new InMemoryCircuitBreaker({ cooldownMs: 10_000 });
    let invocations = 0;
    const failing = async (): Promise<never> => {
      invocations += 1;
      throw new ErpNextError("down", 503, null, "http");
    };

    for (let i = 0; i < DEFAULT_FAILURE_THRESHOLD; i += 1) {
      await expect(breaker.execute("school-a", failing)).rejects.toThrow();
    }
    expect(invocations).toBe(DEFAULT_FAILURE_THRESHOLD);
    expect(await breaker.state("school-a")).toBe("open");

    await expect(breaker.execute("school-a", failing)).rejects.toBeInstanceOf(CircuitOpenError);
    // The point of the breaker: the upstream was not touched by the rejected call.
    expect(invocations).toBe(DEFAULT_FAILURE_THRESHOLD);
  });

  test("one school's outage does not open another school's circuit", async () => {
    const breaker = new InMemoryCircuitBreaker({ cooldownMs: 10_000 });
    const failing = async (): Promise<never> => {
      throw new ErpNextError("down", 503, null, "http");
    };

    for (let i = 0; i < DEFAULT_FAILURE_THRESHOLD; i += 1) {
      await expect(breaker.execute("school-a", failing)).rejects.toThrow();
    }

    expect(await breaker.state("school-a")).toBe("open");
    expect(await breaker.state("school-b")).toBe("closed");
    await expect(breaker.execute("school-b", async () => "ok")).resolves.toBe("ok");
  });

  test("admits a probe after the cooldown and closes on success", async () => {
    const breaker = new InMemoryCircuitBreaker({ cooldownMs: 1 });
    const failing = async (): Promise<never> => {
      throw new ErpNextError("down", 503, null, "http");
    };

    for (let i = 0; i < DEFAULT_FAILURE_THRESHOLD; i += 1) {
      await expect(breaker.execute("school-c", failing)).rejects.toThrow();
    }
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(await breaker.state("school-c")).toBe("half_open");
    await expect(breaker.execute("school-c", async () => "recovered")).resolves.toBe("recovered");
    expect(await breaker.state("school-c")).toBe("closed");
  });

  test("a 4xx does not count toward opening — ERPNext is healthy, the request was not", async () => {
    const breaker = new InMemoryCircuitBreaker({
      cooldownMs: 10_000,
      isFailure: isTransientErpNextFailure,
    });
    const rejecting = async (): Promise<never> => {
      throw new ErpNextError("bad input", 400, null, "http");
    };

    for (let i = 0; i < DEFAULT_FAILURE_THRESHOLD * 2; i += 1) {
      await expect(breaker.execute("school-d", rejecting)).rejects.toThrow();
    }

    expect(await breaker.state("school-d")).toBe("closed");
  });

  test("an open circuit surfaces through the client as kind 'circuit_open'", async () => {
    const breaker = new InMemoryCircuitBreaker({
      cooldownMs: 10_000,
      isFailure: isTransientErpNextFailure,
    });
    stubFetch([{ status: 503, body: { message: "down" } }]);
    const client = makeClient({ circuitKey: "school-e", circuitBreaker: breaker });

    // One *request* is one failure, not three: the breaker wraps the whole retry loop, so a
    // request that exhausted its attempts against one outage counts once. Five requests, not two.
    for (let i = 0; i < DEFAULT_FAILURE_THRESHOLD; i += 1) {
      await expect(client.get("/x")).rejects.toThrow();
    }

    const error = (await client.get("/x").catch((e) => e)) as ErpNextError;
    expect(error.kind).toBe("circuit_open");
    expect(error.status).toBe(503);
  });
});

describe("currency minor units", () => {
  // The reason this module exists. JOD carries three decimal places, so every one of these is
  // wrong under the usual two-decimal assumption.
  test("round-trips JOD at three decimal places", () => {
    const minor = toMinorUnits(1250.5, 3);
    expect(minor).toBe(1250500n);
    expect(fromMinorUnits(minor, 3)).toBeCloseTo(1250.5, 6);
    expect(formatMinorUnits(minor, 3)).toBe("1250.500");
  });

  test("keeps the third decimal that a two-decimal assumption would drop", () => {
    expect(toMinorUnits(12.345, 3)).toBe(12345n);
    expect(formatMinorUnits(12345n, 3)).toBe("12.345");
    expect(formatMinorUnits(12345n, 2)).toBe("123.45");
  });

  test("pads amounts smaller than one unit", () => {
    expect(formatMinorUnits(5n, 3)).toBe("0.005");
    expect(formatMinorUnits(0n, 3)).toBe("0.000");
  });

  test("handles zero-decimal currencies without a stray separator", () => {
    expect(formatMinorUnits(1500n, 0)).toBe("1500");
  });

  test("formats large amounts without floating-point drift", () => {
    // 2^53 exceeded: this is precisely the case a Number-based formatter gets wrong.
    expect(formatMinorUnits(9007199254740993n, 3)).toBe("9007199254740.993");
  });
});
