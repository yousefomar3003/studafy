/* eslint-disable import-x/no-unresolved -- "bun:test" is a virtual Bun built-in */
import { describe, expect, test } from "bun:test";
/* eslint-enable import-x/no-unresolved */

import { sanitizeQueryParams, sanitizeSensitivePath } from "./sensitive-path";

describe("sanitizeSensitivePath", () => {
  test("redacts invitation bearer tokens from exact and unmatched descendant paths", () => {
    const token = "a".repeat(64);
    expect(sanitizeSensitivePath(`/api/auth/invitations/${token}/verify`)).toBe(
      "/api/auth/invitations/[REDACTED]/verify",
    );
    expect(sanitizeSensitivePath(`/api/auth/invitations/${token}/verify/unmatched`)).toBe(
      "/api/auth/invitations/[REDACTED]/verify/unmatched",
    );
  });

  test("redacts the invitation token on activate and the activation OAuth routes", () => {
    const token = "b".repeat(64);
    expect(sanitizeSensitivePath(`/api/auth/invitations/${token}/activate`)).toBe(
      "/api/auth/invitations/[REDACTED]/activate",
    );
    expect(sanitizeSensitivePath(`/api/auth/invitations/${token}/oauth/google/start`)).toBe(
      "/api/auth/invitations/[REDACTED]/oauth/google/start",
    );
    expect(
      sanitizeSensitivePath(`/api/auth/invitations/${token}/oauth/apple/mobile-exchange`),
    ).toBe("/api/auth/invitations/[REDACTED]/oauth/apple/mobile-exchange");
  });

  test("redacts the school email-verification token", () => {
    const token = "c".repeat(64);
    expect(sanitizeSensitivePath(`/api/schools/verify-email/${token}`)).toBe(
      "/api/schools/verify-email/[REDACTED]",
    );
  });

  test("leaves unrelated paths unchanged", () => {
    expect(sanitizeSensitivePath("/api/invitations/id/revoke")).toBe("/api/invitations/id/revoke");
    expect(sanitizeSensitivePath("/api/schools/verify-email")).toBe("/api/schools/verify-email");
    expect(sanitizeSensitivePath("/api/schools/abc/students")).toBe("/api/schools/abc/students");
  });
});

describe("sanitizeQueryParams", () => {
  test("redacts credential-shaped keys and keeps the rest", () => {
    const params = new URLSearchParams(
      "code=c1&state=s1&token=t1&password=p1&secret=x1&Token=t2&page=2&provider_linked=google",
    );
    expect(sanitizeQueryParams(params)).toEqual({
      code: "[REDACTED]",
      state: "[REDACTED]",
      token: "[REDACTED]",
      password: "[REDACTED]",
      secret: "[REDACTED]",
      Token: "[REDACTED]",
      page: "2",
      provider_linked: "google",
    });
  });
});
