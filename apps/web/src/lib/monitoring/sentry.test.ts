// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";

const initMock = mock();
const captureExceptionMock = mock();
const setUserMock = mock();

// Only this file imports @sentry/react through `./sentry` — the mock never has another test file's
// import to collide with (see DeviceSessionsPanel.test.tsx's own note on why a wholesale
// mock.module of a *shared* module must stay file-local).
mock.module("@sentry/react", () => ({
  init: initMock,
  captureException: captureExceptionMock,
  setUser: setUserMock,
}));

const { captureException, initMonitoring, setMonitoringUser, triggerTestErrorFromQueryParam } =
  await import("./sentry");

const ORIGINAL_DSN = process.env.VITE_SENTRY_DSN;

afterEach(() => {
  if (ORIGINAL_DSN === undefined) {
    delete process.env.VITE_SENTRY_DSN;
  } else {
    process.env.VITE_SENTRY_DSN = ORIGINAL_DSN;
  }
  initMock.mockClear();
  captureExceptionMock.mockClear();
  setUserMock.mockClear();
});

describe("with no DSN configured", () => {
  test("initMonitoring, captureException, and setMonitoringUser all no-op", () => {
    delete process.env.VITE_SENTRY_DSN;

    initMonitoring();
    captureException(new Error("boom"));
    setMonitoringUser("user-1");

    expect(initMock).not.toHaveBeenCalled();
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(setUserMock).not.toHaveBeenCalled();
  });
});

describe("with a DSN configured", () => {
  test("initMonitoring configures dsn, environment, release, and the PII scrubbers", () => {
    process.env.VITE_SENTRY_DSN = "https://public@o0.ingest.sentry.io/1";
    process.env.VITE_SENTRY_ENVIRONMENT = "staging";
    process.env.VITE_RELEASE_VERSION = "abc123";

    initMonitoring();

    expect(initMock).toHaveBeenCalledTimes(1);
    const config = initMock.mock.calls[0]?.[0];
    expect(config).toMatchObject({
      dsn: "https://public@o0.ingest.sentry.io/1",
      environment: "staging",
      release: "abc123",
      sendDefaultPii: false,
    });
    expect(typeof config.beforeSend).toBe("function");
    expect(typeof config.beforeBreadcrumb).toBe("function");

    delete process.env.VITE_SENTRY_ENVIRONMENT;
    delete process.env.VITE_RELEASE_VERSION;
  });

  test("captureException forwards the error and extra context to Sentry", () => {
    process.env.VITE_SENTRY_DSN = "https://public@o0.ingest.sentry.io/1";
    const error = new Error("boom");

    captureException(error, { componentStack: "in <Widget>" });

    expect(captureExceptionMock).toHaveBeenCalledWith(error, {
      extra: { componentStack: "in <Widget>" },
    });
  });

  test("captureException omits the hint entirely when no extra context is given", () => {
    process.env.VITE_SENTRY_DSN = "https://public@o0.ingest.sentry.io/1";
    const error = new Error("boom");

    captureException(error);

    expect(captureExceptionMock).toHaveBeenCalledWith(error, undefined);
  });

  test("setMonitoringUser sets an id-only user context, and clears it for null", () => {
    process.env.VITE_SENTRY_DSN = "https://public@o0.ingest.sentry.io/1";

    setMonitoringUser("user-1");
    expect(setUserMock).toHaveBeenLastCalledWith({ id: "user-1" });

    setMonitoringUser(null);
    expect(setUserMock).toHaveBeenLastCalledWith(null);
  });
});

describe("triggerTestErrorFromQueryParam", () => {
  test("throws via the scheduler when ?sentry-test is present", () => {
    expect(() => triggerTestErrorFromQueryParam("?sentry-test", (fn) => fn())).toThrow(
      /sentry-test/,
    );
  });

  test("matches sentry-test alongside other query params", () => {
    expect(() => triggerTestErrorFromQueryParam("?foo=bar&sentry-test", (fn) => fn())).toThrow();
  });

  test("does not schedule anything for a normal query string", () => {
    const scheduleThrow = mock();

    triggerTestErrorFromQueryParam("?foo=bar", scheduleThrow);

    expect(scheduleThrow).not.toHaveBeenCalled();
  });

  test("does not schedule anything for an empty query string", () => {
    const scheduleThrow = mock();

    triggerTestErrorFromQueryParam("", scheduleThrow);

    expect(scheduleThrow).not.toHaveBeenCalled();
  });
});
