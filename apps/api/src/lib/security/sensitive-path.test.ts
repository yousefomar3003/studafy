/* eslint-disable import-x/no-unresolved -- "bun:test" is a virtual Bun built-in */
import { describe, expect, test } from "bun:test";
/* eslint-enable import-x/no-unresolved */

import { sanitizeSensitivePath } from "./sensitive-path";

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

  test("leaves unrelated paths unchanged", () => {
    expect(sanitizeSensitivePath("/api/invitations/id/revoke")).toBe("/api/invitations/id/revoke");
  });
});
