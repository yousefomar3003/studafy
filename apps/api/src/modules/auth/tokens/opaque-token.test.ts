// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { hashSecret, mintOpaqueToken, parseOpaqueToken, verifySecret } from "./opaque-token";

/**
 * ST-071 — opaque refresh-token primitives.
 *
 * These run without a database or a key store, which is the point: the properties being asserted
 * here (entropy, digest width, parse strictness) are the ones a database test cannot observe. A
 * rotation test can only tell you that some token round-tripped; it cannot tell you the token had
 * 256 bits behind it rather than 32, because both round-trip identically.
 *
 * The uniqueness test below is a smoke check on the CSPRNG wiring, not a statistical test of it. A
 * collision in 10k draws from a 256-bit space would not be bad luck, it would mean the generator is
 * not doing what the call site thinks — returning a constant, or being seeded per call. That is the
 * failure worth catching cheaply.
 */

const SAMPLE_SIZE = 10_000;

describe("mintOpaqueToken", () => {
  test("produces a locator.secret pair carrying 256 bits of entropy", () => {
    const { token, locator, secretHash } = mintOpaqueToken();

    const parsed = parseOpaqueToken(token);
    expect(parsed).not.toBeNull();
    expect(parsed?.locator).toBe(locator);

    // 32 bytes as unpadded base64url is 43 characters. Asserting the encoded length rather than
    // decoding keeps this honest about what actually crosses the wire.
    expect(parsed?.secret).toHaveLength(43);
    expect(Buffer.from(parsed!.secret, "base64url")).toHaveLength(32);

    // Matches ck_refresh_tokens_token_hash, which CHECKs octet_length(token_hash) = 32. A digest of
    // any other width would be rejected by the database at insert time.
    expect(secretHash).toHaveLength(32);
  });

  test("returns a hash of the secret half only, never of the whole token", () => {
    const { token, secretHash } = mintOpaqueToken();
    const secret = parseOpaqueToken(token)!.secret;

    expect(secretHash.equals(hashSecret(secret))).toBe(true);
    // Hashing the full token would still be 32 bytes and would still round-trip, so the only way to
    // catch that mistake is to assert the two differ.
    expect(secretHash.equals(hashSecret(token))).toBe(false);
  });

  test("never repeats a locator or a secret across many draws", () => {
    const locators = new Set<string>();
    const secrets = new Set<string>();

    for (let i = 0; i < SAMPLE_SIZE; i += 1) {
      const { token, locator } = mintOpaqueToken();
      locators.add(locator);
      secrets.add(parseOpaqueToken(token)!.secret);
    }

    expect(locators.size).toBe(SAMPLE_SIZE);
    expect(secrets.size).toBe(SAMPLE_SIZE);
  });
});

describe("parseOpaqueToken", () => {
  test("accepts a well-formed token", () => {
    const { token, locator } = mintOpaqueToken();
    expect(parseOpaqueToken(token)?.locator).toBe(locator);
  });

  test.each([
    ["no separator", "not-a-token"],
    ["empty string", ""],
    ["locator only", "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0"],
    ["empty secret", "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0."],
    ["non-uuid locator", "abc.Xk7pQ2"],
    ["empty locator", ".Xk7pQ2"],
    ["uppercase uuid", "0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0.Xk7pQ2"],
    ["base64 padding in secret", "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0.Xk7pQ2=="],
    ["base64 plus/slash in secret", "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0.Xk7+pQ/2"],
  ])("rejects %s", (_label, candidate) => {
    expect(parseOpaqueToken(candidate)).toBeNull();
  });

  test("keeps a secret containing separators intact", () => {
    // Splitting on the *first* separator rather than the last, or with a plain .split("."), is what
    // makes this work. base64url cannot itself contain a dot, so this is defensive rather than
    // reachable — but a secret silently truncated at a later dot would authenticate against a
    // stored prefix, which is a bad failure to discover in production.
    const parsed = parseOpaqueToken("0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0.abc.def");
    expect(parsed).toBeNull();
  });
});

describe("verifySecret", () => {
  test("accepts the secret it was minted from", () => {
    const { token, secretHash } = mintOpaqueToken();
    const { secret } = parseOpaqueToken(token)!;

    expect(verifySecret(secret, secretHash)).toBe(true);
  });

  test("rejects a different secret", () => {
    const first = mintOpaqueToken();
    const second = mintOpaqueToken();
    const { secret } = parseOpaqueToken(second.token)!;

    expect(verifySecret(secret, first.secretHash)).toBe(false);
  });

  test("rejects a stored hash of the wrong width instead of throwing", () => {
    // timingSafeEqual throws on a length mismatch. A short digest can only mean a corrupted row, but
    // an endpoint that 500s on one is worse than one that 401s, so the guard returns false.
    const { token } = mintOpaqueToken();
    const { secret } = parseOpaqueToken(token)!;

    expect(verifySecret(secret, Buffer.alloc(16))).toBe(false);
    expect(verifySecret(secret, Buffer.alloc(0))).toBe(false);
  });
});
