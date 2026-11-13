import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";

const initMock = mock();
const captureExceptionMock = mock();
const captureMessageMock = mock();
const addBreadcrumbMock = mock();
const closeMock = mock(async () => true);
const withIsolationScopeMock = mock((callback: () => unknown) => callback());
const onUnhandledRejectionIntegrationMock = mock((options: unknown) => ({
  name: "OnUnhandledRejection",
  options,
}));
const enableMock = mock();
const dedupeIntegrationMock = mock(() => ({ name: "Dedupe" }));

// Only this file imports @sentry/bun / @sentry/node through `./errorMonitoring` — the mocks never
// have another test file's import to collide with (the same file-local rule
// apps/web/src/lib/monitoring/sentry.test.ts documents for its own mock.module).
mock.module("@sentry/bun", () => ({
  init: initMock,
  captureException: captureExceptionMock,
  captureMessage: captureMessageMock,
  addBreadcrumb: addBreadcrumbMock,
  close: closeMock,
  withIsolationScope: withIsolationScopeMock,
  onUnhandledRejectionIntegration: onUnhandledRejectionIntegrationMock,
  dedupeIntegration: dedupeIntegrationMock,
}));
// A real AsyncLocalStorage manager stands in for Sentry's: initErrorMonitoring() registers it as
// the process-wide OTel context manager, and the other test files in this package (httpTracing,
// queueTracing) need whichever manager wins that one-shot registration to actually work.
mock.module("@sentry/node", () => ({
  SentryContextManager: class extends AsyncLocalStorageContextManager {
    override enable(): this {
      enableMock();
      return super.enable();
    }
  },
}));

const {
  captureError,
  forwardLog,
  initErrorMonitoring,
  isErrorMonitoringEnabled,
  withErrorMonitoringScope,
} = await import("./errorMonitoring");

const OPTIONS = {
  dsn: "https://public@o0.ingest.sentry.io/1",
  environment: "staging",
  release: "abc123",
  serviceName: "api",
};

let handle: Awaited<ReturnType<typeof initErrorMonitoring>> = null;

afterEach(async () => {
  await handle?.shutdown();
  handle = null;
  for (const fn of [
    initMock,
    captureExceptionMock,
    captureMessageMock,
    addBreadcrumbMock,
    closeMock,
    withIsolationScopeMock,
    enableMock,
  ]) {
    fn.mockClear();
  }
});

describe("with no DSN configured", () => {
  test.each([undefined, ""])("every export is a no-op (dsn=%p)", (dsn) => {
    handle = initErrorMonitoring({ ...OPTIONS, dsn });

    captureError(new Error("boom"));
    forwardLog("error", "failed", { err: new Error("boom") });
    forwardLog("warn", "slow");
    const result = withErrorMonitoringScope(() => 42);

    expect(handle).toBeNull();
    expect(isErrorMonitoringEnabled()).toBe(false);
    expect(result).toBe(42);
    expect(initMock).not.toHaveBeenCalled();
    expect(enableMock).not.toHaveBeenCalled();
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(captureMessageMock).not.toHaveBeenCalled();
    expect(addBreadcrumbMock).not.toHaveBeenCalled();
    expect(withIsolationScopeMock).not.toHaveBeenCalled();
  });
});

describe("with a DSN configured", () => {
  test("initialises Sentry without PII, without tracing, and with the scrubbers", () => {
    handle = initErrorMonitoring(OPTIONS);

    expect(handle).not.toBeNull();
    expect(isErrorMonitoringEnabled()).toBe(true);
    expect(enableMock).toHaveBeenCalledTimes(1);
    const config = initMock.mock.calls[0]?.[0];
    expect(config).toMatchObject({
      dsn: OPTIONS.dsn,
      environment: "staging",
      release: "abc123",
      sendDefaultPii: false,
      skipOpenTelemetrySetup: true,
      initialScope: { tags: { service: "api" } },
    });
    expect(config.tracesSampleRate).toBeUndefined();
    expect(typeof config.beforeSend).toBe("function");
    expect(typeof config.beforeBreadcrumb).toBe("function");
  });

  test("drops the integrations that collect headers, console output or spans", () => {
    handle = initErrorMonitoring(OPTIONS);
    const integrations = initMock.mock.calls[0]?.[0].integrations as (
      defaults: { name: string }[],
    ) => { name: string; options?: unknown }[];

    const names = [
      "InboundFilters",
      "LinkedErrors",
      "RequestData",
      "Console",
      "Http",
      "NodeFetch",
      "OnUncaughtException",
      "OnUnhandledRejection",
      "BunServer",
      "ProcessSession",
    ];
    const result = integrations(names.map((name) => ({ name })));

    expect(result.map((integration) => integration.name)).toEqual([
      "InboundFilters",
      "LinkedErrors",
      "OnUncaughtException",
      "OnUnhandledRejection",
      "Dedupe",
    ]);
    expect(result.find((i) => i.name === "OnUnhandledRejection")?.options).toEqual({
      mode: "strict",
    });
  });

  test("captureError forwards defined tags, an id-only user and extra", () => {
    handle = initErrorMonitoring(OPTIONS);
    const error = new Error("boom");

    captureError(error, {
      tags: { request_id: "r-1", school_id: "s-1", route: undefined, job_id: null },
      userId: "u-1",
      extra: { status: 500 },
    });

    expect(captureExceptionMock).toHaveBeenCalledWith(error, {
      level: "error",
      tags: { request_id: "r-1", school_id: "s-1" },
      user: { id: "u-1" },
      extra: { status: 500 },
    });
  });

  test("shutdown flushes and disables further reporting", async () => {
    handle = initErrorMonitoring(OPTIONS);
    await handle?.shutdown(500);
    handle = null;

    captureError(new Error("late"));

    expect(closeMock).toHaveBeenCalledWith(500);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  test("withErrorMonitoringScope runs the callback in an isolation scope", () => {
    handle = initErrorMonitoring(OPTIONS);

    expect(withErrorMonitoringScope(() => "done")).toBe("done");
    expect(withIsolationScopeMock).toHaveBeenCalledTimes(1);
  });
});

describe("forwardLog", () => {
  test("a warn becomes a scrubbed breadcrumb, never an event", () => {
    handle = initErrorMonitoring(OPTIONS);

    forwardLog("warn", "request failed", {
      request_id: "r-1",
      status: 403,
      email: "a@b.com",
      err: new Error("not your school"),
    });

    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(captureMessageMock).not.toHaveBeenCalled();
    expect(addBreadcrumbMock).toHaveBeenCalledWith({
      category: "log",
      level: "warning",
      message: "request failed",
      data: {
        request_id: "r-1",
        status: 403,
        email: "[Redacted]",
        err: { type: "Error", message: "not your school" },
      },
    });
  });

  test("an error with an attached Error is captured as an exception, ids promoted to tags", () => {
    handle = initErrorMonitoring(OPTIONS);
    const error = new Error("db down");

    forwardLog("error", "relay failed", {
      err: error,
      school_id: "s-1",
      user_id: "u-1",
      batch: 3,
    });

    expect(captureExceptionMock).toHaveBeenCalledWith(error, {
      level: "error",
      tags: { school_id: "s-1" },
      user: { id: "u-1" },
      extra: { batch: 3, log_message: "relay failed" },
    });
  });

  test("an error without an Error is captured as a message event", () => {
    handle = initErrorMonitoring(OPTIONS);

    forwardLog("fatal", "invariant broken", { queue: "billing", job_id: "j-1" });

    expect(captureMessageMock).toHaveBeenCalledWith("invariant broken", {
      level: "fatal",
      tags: { queue: "billing", job_id: "j-1" },
      extra: {},
    });
  });

  test("does not report an error captureError already reported", () => {
    handle = initErrorMonitoring(OPTIONS);
    const error = new Error("boom");

    captureError(error, { tags: { request_id: "r-1" } });
    forwardLog("error", "request failed", { err: error });

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });

  test("ignores levels below warn", () => {
    handle = initErrorMonitoring(OPTIONS);

    forwardLog("info", "request completed");
    forwardLog("debug", "cache hit");

    expect(addBreadcrumbMock).not.toHaveBeenCalled();
    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  test("never throws, even if Sentry does", () => {
    handle = initErrorMonitoring(OPTIONS);
    captureMessageMock.mockImplementationOnce(() => {
      throw new Error("transport exploded");
    });

    expect(() => forwardLog("error", "failed")).not.toThrow();
  });
});
