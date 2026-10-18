// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { captureError, scrubEvent, startErrorTracking } from "./errorTracking";

import type { ErrorEvent } from "@sentry/bun";

describe("error tracking", () => {
  test("stays off without a DSN, and capturing is then a harmless no-op", () => {
    expect(startErrorTracking({ dsn: "", environment: "test", serviceName: "api" })).toBe(false);
    expect(() => captureError(new Error("boom"), { request_id: "r-1" })).not.toThrow();
  });

  test("strips request bodies, headers, cookies and query strings, and all of a user but the id", () => {
    const event = {
      type: undefined,
      request: {
        url: "https://api.studafy.com/api/students/1",
        method: "POST",
        data: '{"answer":"a child typed this"}',
        headers: { authorization: "Bearer secret" },
        cookies: { session: "secret" },
        query_string: "email=parent@example.com",
      },
      user: { id: "user-1", email: "parent@example.com", ip_address: "10.0.0.1" },
    } as unknown as ErrorEvent;

    const scrubbed = scrubEvent(event);

    expect(scrubbed.request).toEqual({
      url: "https://api.studafy.com/api/students/1",
      method: "POST",
    });
    expect(scrubbed.user).toEqual({ id: "user-1" });
  });

  test("drops a user with no id entirely", () => {
    const scrubbed = scrubEvent({ user: { email: "x@example.com" } } as unknown as ErrorEvent);
    expect(scrubbed.user).toBeUndefined();
  });
});
