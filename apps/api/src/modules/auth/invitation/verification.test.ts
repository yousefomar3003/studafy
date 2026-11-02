/* eslint-disable import-x/no-unresolved -- "bun:test" is a virtual Bun built-in */
import { describe, expect, test } from "bun:test";
/* eslint-enable import-x/no-unresolved */

import {
  evaluateInvitationState,
  hashInvitationToken,
  INVITATION_TOKEN_PATTERN,
  invitationHashesMatch,
  maskInvitationEmail,
} from "./verification";

const future = new Date("2030-01-01T00:00:00.000Z");
const past = new Date("2020-01-01T00:00:00.000Z");
const now = new Date("2025-01-01T00:00:00.000Z").getTime();

describe("invitation verification token handling", () => {
  test("accepts only the issuer's 64-character lowercase hexadecimal format", () => {
    expect(INVITATION_TOKEN_PATTERN.test("a".repeat(64))).toBe(true);
    expect(INVITATION_TOKEN_PATTERN.test("A".repeat(64))).toBe(false);
    expect(INVITATION_TOKEN_PATTERN.test("a".repeat(63))).toBe(false);
    expect(INVITATION_TOKEN_PATTERN.test("g".repeat(64))).toBe(false);
  });

  test("hashes tokens to deterministic 32-byte SHA-256 digests", () => {
    const token = "a".repeat(64);
    expect(hashInvitationToken(token)).toEqual(hashInvitationToken(token));
    expect(hashInvitationToken(token)).toHaveLength(32);
  });

  test("compares only fixed-width candidates with a timing-safe primitive", () => {
    const digest = hashInvitationToken("a".repeat(64));
    expect(invitationHashesMatch(digest, Buffer.from(digest))).toBe(true);
    expect(invitationHashesMatch(digest, hashInvitationToken("b".repeat(64)))).toBe(false);
    expect(invitationHashesMatch(digest, Buffer.alloc(31))).toBe(false);
  });
});

describe("invitation lifecycle precedence", () => {
  test("uses EXPIRED before every other failure", () => {
    expect(
      evaluateInvitationState(
        {
          expiresAt: past,
          revokedAt: past,
          consumedAt: past,
          schoolStatus: "suspended",
        },
        now,
      ),
    ).toBe("EXPIRED");
  });

  test("treats an invitation expiring exactly now as expired", () => {
    expect(
      evaluateInvitationState(
        { expiresAt: new Date(now), revokedAt: null, consumedAt: null, schoolStatus: "active" },
        now,
      ),
    ).toBe("EXPIRED");
  });

  test("orders revoked before consumed and school state", () => {
    expect(
      evaluateInvitationState(
        { expiresAt: future, revokedAt: past, consumedAt: past, schoolStatus: "suspended" },
        now,
      ),
    ).toBe("REVOKED");
  });

  test("orders consumed before school state", () => {
    expect(
      evaluateInvitationState(
        { expiresAt: future, revokedAt: null, consumedAt: past, schoolStatus: "archived" },
        now,
      ),
    ).toBe("CONSUMED");
  });

  test("maps every non-active school state to SCHOOL_SUSPENDED", () => {
    for (const schoolStatus of ["pending", "suspended", "archived"] as const) {
      expect(
        evaluateInvitationState(
          { expiresAt: future, revokedAt: null, consumedAt: null, schoolStatus },
          now,
        ),
      ).toBe("SCHOOL_SUSPENDED");
    }
  });

  test("returns VALID only after all failure checks pass", () => {
    expect(
      evaluateInvitationState(
        { expiresAt: future, revokedAt: null, consumedAt: null, schoolStatus: "active" },
        now,
      ),
    ).toBe("VALID");
  });
});

describe("invitation email masking", () => {
  test("normalizes case and masks the local part with a fixed marker", () => {
    expect(maskInvitationEmail(" John.Doe@Example.COM ")).toBe("j***e@example.com");
  });

  test("handles one- and two-character local parts deterministically", () => {
    expect(maskInvitationEmail("a@example.com")).toBe("a***a@example.com");
    expect(maskInvitationEmail("ab@example.com")).toBe("a***b@example.com");
  });

  test("does not echo malformed stored addresses", () => {
    expect(maskInvitationEmail("not-an-email")).toBe("***");
  });
});
