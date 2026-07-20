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

const SCHOOL_ID = "22222222-2222-2222-2222-222222222222";
const USER_ID = "11111111-1111-1111-1111-111111111111";

describe("mintOpaqueToken", () => {
  test("produces school.user.secret with 256 bits of entropy in the secret", () => {
    const { token, secretHash } = mintOpaqueToken(SCHOOL_ID, USER_ID);

    const parsed = parseOpaqueToken(token);
    expect(parsed).not.toBeNull();
    expect(parsed?.schoolId).toBe(SCHOOL_ID);
    expect(parsed?.userId).toBe(USER_ID);

    // 32 bytes as unpadded base64url is 43 characters. Asserting the encoded length rather than
    // decoding keeps this honest about what actually crosses the wire.
    expect(parsed?.secret).toHaveLength(43);
    expect(Buffer.from(parsed!.secret, "base64url")).toHaveLength(32);

    // Matches ck_refresh_tokens_token_hash, which CHECKs octet_length(token_hash) = 32. A digest of
    // any other width would be rejected by the database at insert time.
    expect(secretHash).toHaveLength(32);
  });

  test("hashes the secret alone, never the ids alongside it", () => {
    const { token, secretHash } = mintOpaqueToken(SCHOOL_ID, USER_ID);
    const secret = parseOpaqueToken(token)!.secret;

    expect(secretHash.equals(hashSecret(secret))).toBe(true);
    // Hashing the whole token would still be 32 bytes and would still round-trip, so the only way to
    // catch that mistake is to assert the two differ. It would also make the digest depend on the
    // ids, so a session could not be found without them being exactly right.
    expect(secretHash.equals(hashSecret(token))).toBe(false);
  });

  test("gives two sessions for the same user different secrets", () => {
    const secrets = new Set<string>();

    for (let i = 0; i < SAMPLE_SIZE; i += 1) {
      const { token } = mintOpaqueToken(SCHOOL_ID, USER_ID);
      secrets.add(parseOpaqueToken(token)!.secret);
    }

    // The ids are constant here on purpose: uniqueness has to come from the secret, since that is
    // the only part the database indexes and the only part an attacker cannot already know.
    expect(secrets.size).toBe(SAMPLE_SIZE);
  });
});

describe("parseOpaqueToken", () => {
  test("accepts a well-formed token", () => {
    const { token } = mintOpaqueToken(SCHOOL_ID, USER_ID);
    expect(parseOpaqueToken(token)).toMatchObject({ schoolId: SCHOOL_ID, userId: USER_ID });
  });

  test.each([
    ["no separators", "not-a-token"],
    ["empty string", ""],
    ["only two parts", `${SCHOOL_ID}.${USER_ID}`],
    ["empty secret", `${SCHOOL_ID}.${USER_ID}.`],
    ["four parts", `${SCHOOL_ID}.${USER_ID}.abc.def`],
    ["non-uuid school", `abc.${USER_ID}.Xk7pQ2`],
    ["non-uuid user", `${SCHOOL_ID}.abc.Xk7pQ2`],
    // A hex uuid with letters in it, so .toUpperCase() actually changes something — the all-digit
    // fixtures above would have made this assertion vacuous.
    ["uppercase uuid", `AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE.${USER_ID}.Xk7pQ2`],
    ["base64 padding in secret", `${SCHOOL_ID}.${USER_ID}.Xk7pQ2==`],
    ["base64 plus/slash in secret", `${SCHOOL_ID}.${USER_ID}.Xk7+pQ/2`],
  ])("rejects %s", (_label, candidate) => {
    expect(parseOpaqueToken(candidate)).toBeNull();
  });

  test("rejects rather than truncating when the secret contains a separator", () => {
    // base64url cannot contain a dot, so this is unreachable in practice — but a secret silently
    // truncated at a later dot would authenticate against a stored prefix, and the uuid checks alone
    // would not catch it. Rejecting on part count is what makes that impossible.
    expect(parseOpaqueToken(`${SCHOOL_ID}.${USER_ID}.abc.def`)).toBeNull();
  });

  test("validates the ids before they are used as a tenant scope", () => {
    // These are fed straight to set_config as app.school_id / app.user_id. The query is
    // parameterised, so this is a shape check rather than an injection defence — but an unparseable
    // uuid should fail in-process rather than as a database error on an unauthenticated endpoint.
    expect(parseOpaqueToken(`${SCHOOL_ID}x.${USER_ID}.Xk7pQ2`)).toBeNull();
    expect(parseOpaqueToken(`../../etc.${USER_ID}.Xk7pQ2`)).toBeNull();
  });
});

describe("verifySecret", () => {
  test("accepts the secret it was minted from", () => {
    const { token, secretHash } = mintOpaqueToken(SCHOOL_ID, USER_ID);
    const { secret } = parseOpaqueToken(token)!;

    expect(verifySecret(secret, secretHash)).toBe(true);
  });

  test("rejects a different secret", () => {
    const first = mintOpaqueToken(SCHOOL_ID, USER_ID);
    const second = mintOpaqueToken(SCHOOL_ID, USER_ID);
    const { secret } = parseOpaqueToken(second.token)!;

    expect(verifySecret(secret, first.secretHash)).toBe(false);
  });

  test("rejects a stored hash of the wrong width instead of throwing", () => {
    // timingSafeEqual throws on a length mismatch. A short digest can only mean a corrupted row, but
    // an endpoint that 500s on one is worse than one that 401s, so the guard returns false.
    const { token } = mintOpaqueToken(SCHOOL_ID, USER_ID);
    const { secret } = parseOpaqueToken(token)!;

    expect(verifySecret(secret, Buffer.alloc(16))).toBe(false);
    expect(verifySecret(secret, Buffer.alloc(0))).toBe(false);
  });
});
