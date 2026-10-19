// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { redactPii, redactPiiText, scrubBreadcrumb, scrubEvent } from "./scrubPii";

import type { ErrorEvent } from "@sentry/bun";

const event = (overrides: Partial<ErrorEvent>): ErrorEvent =>
  ({ type: undefined, ...overrides }) as ErrorEvent;

describe("scrubEvent", () => {
  test("reduces the user to its id", () => {
    const scrubbed = scrubEvent(
      event({ user: { id: "user-1", email: "a@b.com", username: "amal", ip_address: "1.2.3.4" } }),
    );
    expect(scrubbed.user).toEqual({ id: "user-1" });
  });

  test("drops a user with no id entirely", () => {
    expect(scrubEvent(event({ user: { email: "a@b.com" } })).user).toBeUndefined();
  });

  test("reduces the request to method and path — no headers, cookies, query or body", () => {
    const scrubbed = scrubEvent(
      event({
        request: {
          method: "POST",
          url: "https://api.studafy.com/api/students?email=a@b.com#frag",
          headers: { authorization: "Bearer eyJ.a.b", cookie: "__Host-session=x" },
          cookies: { session: "x" },
          query_string: "email=a@b.com",
          data: { password: "hunter2" },
        },
      }),
    );
    expect(scrubbed.request).toEqual({
      method: "POST",
      url: "https://api.studafy.com/api/students",
    });
  });

  test("redacts PII-shaped keys at depth in extra and contexts, keeping ids and enums", () => {
    const scrubbed = scrubEvent(
      event({
        extra: {
          school_id: "school-1",
          status: 500,
          guardian: { firstName: "Amal", phoneNumber: "+966501234567", role: "parent" },
          rows: [{ email: "a@b.com", studentId: "s-1" }],
        },
        contexts: { provider: { apiKey: "sk_live_x", accessToken: "t", region: "me-south-1" } },
      }),
    );
    expect(scrubbed.extra).toEqual({
      school_id: "school-1",
      status: 500,
      guardian: { firstName: "[Redacted]", phoneNumber: "[Redacted]", role: "parent" },
      rows: [{ email: "[Redacted]", studentId: "s-1" }],
    });
    expect(scrubbed.contexts).toEqual({
      provider: { apiKey: "[Redacted]", accessToken: "[Redacted]", region: "me-south-1" },
    });
  });

  test("redacts PII inside exception values and the message", () => {
    const scrubbed = scrubEvent(
      event({
        message: "send to parent@example.com failed",
        exception: {
          values: [
            { type: "PostgresError", value: 'duplicate key (email)=(kid@school.sa) on "users"' },
            { type: "Error" },
          ],
        },
      }),
    );
    expect(scrubbed.message).toBe("send to [Redacted] failed");
    expect(scrubbed.exception?.values?.[0]?.value).toBe(
      'duplicate key (email)=([Redacted]) on "users"',
    );
    expect(scrubbed.exception?.values?.[1]).toEqual({ type: "Error" });
  });

  test("scrubs every breadcrumb already on the event", () => {
    const scrubbed = scrubEvent(
      event({ breadcrumbs: [{ message: "login a@b.com", data: { password: "x", status: 401 } }] }),
    );
    expect(scrubbed.breadcrumbs).toEqual([
      { message: "login [Redacted]", data: { password: "[Redacted]", status: 401 } },
    ]);
  });
});

describe("scrubBreadcrumb", () => {
  test("redacts the message and data", () => {
    expect(
      scrubBreadcrumb({
        category: "log",
        message: "token eyJhbGciOi.eyJzdWIiOi.sig rejected",
        data: { cookie: "x", request_id: "r-1" },
      }),
    ).toEqual({
      category: "log",
      message: "token [Redacted] rejected",
      data: { cookie: "[Redacted]", request_id: "r-1" },
    });
  });

  test("leaves a breadcrumb with nothing to scrub unchanged", () => {
    expect(scrubBreadcrumb({ category: "log", level: "warning" })).toEqual({
      category: "log",
      level: "warning",
    });
  });
});

describe("redactPiiText", () => {
  test.each([
    ["reach me at amal.k+test@school.edu.sa", "reach me at [Redacted]"],
    ["Authorization: Bearer abc.def", "Authorization: [Redacted]"],
    ["call +966 50 123 4567 now", "call [Redacted] now"],
    ["call 0501234567 now", "call [Redacted] now"],
    ["call 050-123-4567 now", "call [Redacted] now"],
  ])("redacts %p", (input, expected) => {
    expect(redactPiiText(input)).toBe(expected);
  });

  test("keeps UUIDs, short numbers and dates intact", () => {
    const text = "job 123e4567-e89b-12d3-a456-426614174000 attempt 3 on 2026-10-13 status 503";
    expect(redactPiiText(text)).toBe(text);
  });
});

describe("redactPii", () => {
  test("passes primitives other than strings through untouched", () => {
    expect(redactPii(42)).toBe(42);
    expect(redactPii(null)).toBeNull();
    expect(redactPii(true)).toBe(true);
  });
});
