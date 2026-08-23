// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { redactPii, scrubBreadcrumb, scrubEvent } from "./scrub-pii";

import type { Breadcrumb, ErrorEvent } from "@sentry/react";

describe("redactPii", () => {
  test("redacts a PII-shaped key at any nesting depth", () => {
    expect(redactPii({ email: "a@b.com", nested: { phone: "555-0100" } })).toEqual({
      email: "[Redacted]",
      nested: { phone: "[Redacted]" },
    });
  });

  test("matches camelCase and snake_case segments equally", () => {
    expect(redactPii({ schoolEmail: "a@b.com", full_name: "Jamie" })).toEqual({
      schoolEmail: "[Redacted]",
      full_name: "[Redacted]",
    });
  });

  test("leaves non-PII fields — ids, enums, counts — untouched", () => {
    const value = { id: "user-1", role: "admin", count: 3, active: true };
    expect(redactPii(value)).toEqual(value);
  });

  test("does not flag a field that merely contains a PII root as a substring", () => {
    // "emailed_at" segments to ["emailed", "at"] -- neither equals the "email" root.
    expect(redactPii({ emailed_at: "2026-08-01T00:00:00.000Z" })).toEqual({
      emailed_at: "2026-08-01T00:00:00.000Z",
    });
  });

  test("redacts inside arrays", () => {
    expect(redactPii([{ email: "a@b.com" }, { id: "1" }])).toEqual([
      { email: "[Redacted]" },
      { id: "1" },
    ]);
  });
});

describe("scrubEvent", () => {
  test("reduces the user context to id only", () => {
    const event = {
      user: { id: "user-1", email: "a@b.com", username: "jamie", ip_address: "203.0.113.5" },
    } as ErrorEvent;

    expect(scrubEvent(event).user).toEqual({ id: "user-1" });
  });

  test("drops the user context entirely when it carries no id", () => {
    const event = { user: { email: "a@b.com" } } as ErrorEvent;

    expect(scrubEvent(event).user).toBeUndefined();
  });

  test("redacts PII-shaped fields in extra, contexts, and request", () => {
    const event = {
      extra: { studentEmail: "a@b.com", submissionId: "sub-1" },
      contexts: { form: { parentPhone: "555-0100" } },
      request: { url: "/account", cookies: { session: "abc" }, data: { plan: "premium" } },
    } as unknown as ErrorEvent;

    // Redaction can replace a field's whole shape (an object -> the literal string
    // "[Redacted]"), which the Sentry event types have no way to express statically — cast to
    // the actual runtime shape rather than fight the types for what is a test-only inspection.
    const scrubbed = scrubEvent(event) as unknown as Record<string, unknown>;

    expect(scrubbed.extra).toEqual({ studentEmail: "[Redacted]", submissionId: "sub-1" });
    expect(scrubbed.contexts).toEqual({ form: { parentPhone: "[Redacted]" } });
    expect(scrubbed.request).toEqual({
      url: "/account",
      cookies: "[Redacted]",
      data: { plan: "premium" },
    });
  });

  test("scrubs every breadcrumb's data alongside the top-level fields", () => {
    const event = {
      breadcrumbs: [{ category: "fetch", data: { authorization: "Bearer xyz", status: 200 } }],
    } as unknown as ErrorEvent;

    expect(scrubEvent(event).breadcrumbs).toEqual([
      { category: "fetch", data: { authorization: "[Redacted]", status: 200 } },
    ]);
  });

  test("passes through an event with nothing to scrub unchanged", () => {
    const event = { message: "boom", level: "error" } as ErrorEvent;

    expect(scrubEvent(event)).toEqual(event);
  });
});

describe("scrubBreadcrumb", () => {
  test("redacts PII-shaped keys in a breadcrumb's data", () => {
    const breadcrumb = {
      category: "xhr",
      data: { email: "a@b.com", statusCode: 500 },
    } as Breadcrumb;

    expect(scrubBreadcrumb(breadcrumb)).toEqual({
      category: "xhr",
      data: { email: "[Redacted]", statusCode: 500 },
    });
  });

  test("passes through a breadcrumb with no data unchanged", () => {
    const breadcrumb = { category: "navigation", message: "/portal" } as Breadcrumb;

    expect(scrubBreadcrumb(breadcrumb)).toBe(breadcrumb);
  });
});
