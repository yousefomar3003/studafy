// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { describe, expect, test } from "bun:test";

import { generateCodeChallenge, generateCodeVerifier, generateNonce, generateState } from "./pkce";

const SAMPLE_SIZE = 10_000;

describe("generateCodeVerifier", () => {
  test("produces a 43-character base64url string", () => {
    const verifier = generateCodeVerifier();
    expect(verifier).toHaveLength(43);
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  test("generates unique verifiers", () => {
    const verifiers = new Set<string>();
    for (let i = 0; i < SAMPLE_SIZE; i++) {
      verifiers.add(generateCodeVerifier());
    }
    expect(verifiers.size).toBe(SAMPLE_SIZE);
  });
});

describe("generateCodeChallenge", () => {
  test("produces a 43-character base64url string", () => {
    const challenge = generateCodeChallenge(generateCodeVerifier());
    expect(challenge).toHaveLength(43);
    expect(challenge).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  test("is deterministic", () => {
    const verifier = "test-verifier-abc123";
    expect(generateCodeChallenge(verifier)).toBe(generateCodeChallenge(verifier));
  });

  test("differs from the verifier", () => {
    const verifier = generateCodeVerifier();
    expect(generateCodeChallenge(verifier)).not.toBe(verifier);
  });
});

describe("generateState", () => {
  test("produces a 64-character hex string", () => {
    const state = generateState();
    expect(state).toHaveLength(64);
    expect(state).toMatch(/^[0-9a-f]+$/);
  });

  test("generates unique states", () => {
    const states = new Set<string>();
    for (let i = 0; i < SAMPLE_SIZE; i++) {
      states.add(generateState());
    }
    expect(states.size).toBe(SAMPLE_SIZE);
  });
});

describe("generateNonce", () => {
  test("produces a 64-character hex string", () => {
    const nonce = generateNonce();
    expect(nonce).toHaveLength(64);
    expect(nonce).toMatch(/^[0-9a-f]+$/);
  });

  test("generates unique nonces", () => {
    const nonces = new Set<string>();
    for (let i = 0; i < SAMPLE_SIZE; i++) {
      nonces.add(generateNonce());
    }
    expect(nonces.size).toBe(SAMPLE_SIZE);
  });
});
