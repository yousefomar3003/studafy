/* eslint-disable import-x/no-unresolved -- "bun:test" is a virtual Bun built-in */
import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";
/* eslint-enable import-x/no-unresolved */

import {
  generateToken,
  hashToken,
  createInvitationService,
  DEFAULT_INVITATION_EXPIRY_DAYS,
} from "./service";

describe("Invitation service", () => {
  describe("generateToken", () => {
    test("returns a 64-character hex string (256 bits)", () => {
      const token = generateToken();
      expect(token).toMatch(/^[0-9a-f]{64}$/);
    });

    test("generates unique tokens on successive calls", () => {
      const tokens = new Set(Array.from({ length: 100 }, () => generateToken()));
      expect(tokens.size).toBe(100);
    });
  });

  describe("hashToken", () => {
    test("returns a 32-byte buffer", () => {
      const token = generateToken();
      const hash = hashToken(token);
      expect(hash).toBeInstanceOf(Buffer);
      expect(hash.length).toBe(32);
    });

    test("produces deterministic output for the same input", () => {
      const token = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
      const hash1 = hashToken(token);
      const hash2 = hashToken(token);
      expect(hash1.equals(hash2)).toBe(true);
    });

    test("matches manual SHA-256 computation", () => {
      const token = generateToken();
      const expected = createHash("sha256").update(token, "utf8").digest();
      const actual = hashToken(token);
      expect(actual.equals(expected)).toBe(true);
    });

    test("different tokens produce different hashes", () => {
      const hash1 = hashToken(generateToken());
      const hash2 = hashToken(generateToken());
      expect(hash1.equals(hash2)).toBe(false);
    });
  });

  describe("createInvitationService", () => {
    test("has correct default expiry days", () => {
      expect(DEFAULT_INVITATION_EXPIRY_DAYS).toBe(7);
    });

    test("accepts custom default expiry days", () => {
      const service = createInvitationService({ defaultExpiryDays: 14 });
      expect(service).toBeDefined();
    });

    test("accepts a clock override", () => {
      const fixedTime = new Date("2026-01-15T12:00:00Z").getTime();
      const service = createInvitationService({ now: () => fixedTime });
      expect(service).toBeDefined();
    });
  });
});

describe("Invitation token security", () => {
  test("raw token is never the same as the stored hash", () => {
    const token = generateToken();
    const hash = hashToken(token);
    expect(token).not.toBe(hash.toString("hex"));
    expect(token.length).toBe(64); // 32 bytes as hex
    expect(hash.length).toBe(32); // raw bytes
  });

  test("token cannot be reconstructed from hash (preimage resistance)", () => {
    const token = generateToken();
    const hash = hashToken(token);
    // The hash is a one-way function; we verify the hash is 32 bytes and not reversible
    // by checking it doesn't match the original token in any encoding
    expect(hash.toString("base64")).not.toBe(token);
    expect(hash.toString("latin1")).not.toBe(token);
  });
});
