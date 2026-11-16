// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import {
  buildDataPayload,
  createFcmSender,
  failuresByCode,
  hasCredentialFailure,
  isUnregisteredToken,
  withTimeout,
} from "./sender";

import type { PushDevice } from "./sender";

const device = (token: string, platform: PushDevice["platform"] = "android"): PushDevice => ({
  id: `device-${token}`,
  token,
  platform,
});

describe("isUnregisteredToken", () => {
  test("recognises the v1 registration-token-not-registered code", () => {
    expect(isUnregisteredToken({ code: "messaging/registration-token-not-registered" })).toBe(true);
  });

  test("recognises the legacy unregistered code", () => {
    expect(isUnregisteredToken({ code: "messaging/unregistered" })).toBe(true);
  });

  test("a missing code is not unregistered", () => {
    expect(isUnregisteredToken({})).toBe(false);
    expect(isUnregisteredToken({ code: undefined })).toBe(false);
  });

  test("an unrelated error is not unregistered", () => {
    expect(isUnregisteredToken({ code: "messaging/invalid-argument" })).toBe(false);
    expect(isUnregisteredToken({ code: "messaging/authentication-error" })).toBe(false);
  });
});

describe("buildDataPayload", () => {
  const base = {
    title: "Maths grade posted",
    body: "Amina scored 18/20",
    notificationType: "GRADE_POSTED",
    dispatchLogId: "log-1",
  };

  test("carries the correlation handles", () => {
    expect(buildDataPayload({ ...base, route: "/courses/c-1/grades" })).toEqual({
      notification_type: "GRADE_POSTED",
      dispatch_log_id: "log-1",
      route: "/courses/c-1/grades",
    });
  });

  test("omits the route when empty rather than sending a bogus deep link", () => {
    const payload = buildDataPayload({ ...base, route: "" });
    expect(payload.route).toBeUndefined();
    expect(payload).toEqual({ notification_type: "GRADE_POSTED", dispatch_log_id: "log-1" });
  });
});

describe("withTimeout", () => {
  test("passes a settled send through", async () => {
    expect(await withTimeout(Promise.resolve(3), 50)).toBe(3);
  });

  test("fails a send that never settles instead of hanging", async () => {
    const never = new Promise<number>(() => undefined);
    let error: unknown;
    try {
      await withTimeout(never, 20);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("timed out");
  });
});

describe("failuresByCode", () => {
  test("counts every failure except dead tokens and successes", () => {
    const failures = failuresByCode([
      { success: true },
      { success: false, error: { code: "messaging/registration-token-not-registered" } },
      { success: false, error: { code: "messaging/third-party-auth-error" } },
      { success: false, error: { code: "messaging/third-party-auth-error" } },
      { success: false, error: { code: "messaging/internal-error" } },
      { success: false, error: {} },
    ]);
    expect(failures).toEqual({
      "messaging/third-party-auth-error": 2,
      "messaging/internal-error": 1,
      unknown: 1,
    });
  });

  test("an APNs credential refusal is told apart from a passing glitch", () => {
    expect(hasCredentialFailure({ "messaging/third-party-auth-error": 3 })).toBe(true);
    expect(hasCredentialFailure({ "messaging/invalid-apns-credentials": 1 })).toBe(true);
    expect(hasCredentialFailure({ "messaging/internal-error": 1 })).toBe(false);
    expect(hasCredentialFailure({})).toBe(false);
  });
});

describe("createFcmSender", () => {
  test("without a service account returns a dry-run sender that counts every device as sent", async () => {
    const warnings: string[] = [];
    const sender = createFcmSender(
      {},
      {
        warn: (_fields, message) => {
          warnings.push(message);
        },
      },
    );

    const result = await sender.send(
      {
        title: "T",
        body: "B",
        route: "/courses/c-1/grades",
        notificationType: "GRADE_POSTED",
        dispatchLogId: "log-1",
      },
      [device("token-a"), device("token-b", "ios")],
    );

    expect(result).toEqual({ unregisteredDeviceIds: [], sent: 2, dryRun: true });
    // The dry run is announced loudly so nobody mistakes it for production behaviour.
    expect(warnings.some((message) => message.includes("dry-run"))).toBe(true);
  });

  test("a service account that is not JSON fails fast", () => {
    expect(() => createFcmSender({ FIREBASE_SERVICE_ACCOUNT: "not json" }, makeLogger())).toThrow(
      /not valid JSON/,
    );
  });

  test("a service account missing required fields fails fast", () => {
    const incomplete = JSON.stringify({ project_id: "studafy" });
    expect(() => createFcmSender({ FIREBASE_SERVICE_ACCOUNT: incomplete }, makeLogger())).toThrow(
      /missing project_id, client_email or private_key/,
    );
  });
});

function makeLogger() {
  return {
    warn: (_fields: Record<string, unknown>, _message: string) => {
      /* no-op */
    },
  };
}
