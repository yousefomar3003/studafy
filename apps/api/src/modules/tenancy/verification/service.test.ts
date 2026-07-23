/* eslint-disable import-x/no-unresolved -- "bun:test" is a virtual Bun built-in */
import { describe, expect, test } from "bun:test";
/* eslint-enable import-x/no-unresolved */

import { generateToken, hashToken, VERIFICATION_TOKEN_PATTERN } from "./service";

describe("verification token handling", () => {
  test("VERIFICATION_TOKEN_PATTERN accepts 64 lowercase hex characters", () => {
    expect(VERIFICATION_TOKEN_PATTERN.test("a".repeat(64))).toBe(true);
    expect(VERIFICATION_TOKEN_PATTERN.test("0123456789abcdef".repeat(4))).toBe(true);
  });

  test("VERIFICATION_TOKEN_PATTERN rejects uppercase hex", () => {
    expect(VERIFICATION_TOKEN_PATTERN.test("A".repeat(64))).toBe(false);
  });

  test("VERIFICATION_TOKEN_PATTERN rejects wrong length", () => {
    expect(VERIFICATION_TOKEN_PATTERN.test("a".repeat(63))).toBe(false);
    expect(VERIFICATION_TOKEN_PATTERN.test("a".repeat(65))).toBe(false);
  });

  test("VERIFICATION_TOKEN_PATTERN rejects non-hex characters", () => {
    expect(VERIFICATION_TOKEN_PATTERN.test("g".repeat(64))).toBe(false);
  });

  test("generateToken returns 64-character lowercase hex string", () => {
    const token = generateToken();
    expect(token).toHaveLength(64);
    expect(VERIFICATION_TOKEN_PATTERN.test(token)).toBe(true);
  });

  test("generateToken produces unique tokens", () => {
    const tokens = new Set(Array.from({ length: 100 }, () => generateToken()));
    expect(tokens.size).toBe(100);
  });

  test("hashToken returns a 32-byte SHA-256 digest", () => {
    const token = generateToken();
    const hash = hashToken(token);
    expect(hash).toHaveLength(32);
  });

  test("hashToken is deterministic for the same input", () => {
    const token = "a".repeat(64);
    const h1 = hashToken(token);
    const h2 = hashToken(token);
    expect(h1.equals(h2)).toBe(true);
  });

  test("hashToken produces different digests for different inputs", () => {
    const h1 = hashToken("a".repeat(64));
    const h2 = hashToken("b".repeat(64));
    expect(h1.equals(h2)).toBe(false);
  });
});
