// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { decodeAccessTokenRoles, decodeAccessTokenUserId } from "./access-token-claims";

/** Builds a JWT-shaped string (header.payload.signature) from a plain payload object, unsigned — this
 * module never checks the signature, so tests don't need a real key. */
function fakeJwt(payload: unknown): string {
  const segment = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${segment({ alg: "RS256" })}.${segment(payload)}.signature`;
}

describe("decodeAccessTokenRoles", () => {
  test("reads the roles claim out of a well-formed token", () => {
    const token = fakeJwt({ sub: "user-1", roles: ["INSTRUCTOR", "ORG_ADMIN"] });
    expect(decodeAccessTokenRoles(token)).toEqual(["INSTRUCTOR", "ORG_ADMIN"]);
  });

  test("drops non-string entries rather than throwing", () => {
    const token = fakeJwt({ roles: ["STUDENT", 42, null, { role: "x" }] });
    expect(decodeAccessTokenRoles(token)).toEqual(["STUDENT"]);
  });

  test("returns an empty array when the claim is missing", () => {
    const token = fakeJwt({ sub: "user-1" });
    expect(decodeAccessTokenRoles(token)).toEqual([]);
  });

  test("returns an empty array when the claim is not an array", () => {
    const token = fakeJwt({ roles: "STUDENT" });
    expect(decodeAccessTokenRoles(token)).toEqual([]);
  });

  test("returns an empty array for a malformed token instead of throwing", () => {
    expect(decodeAccessTokenRoles("not-a-jwt")).toEqual([]);
    expect(decodeAccessTokenRoles("")).toEqual([]);
    expect(decodeAccessTokenRoles("only.two")).toEqual([]);
    expect(decodeAccessTokenRoles("a.not-base64url!!!.c")).toEqual([]);
  });

  test("returns an empty array when the payload segment is not JSON", () => {
    const notJson = btoa("plainly not json");
    expect(decodeAccessTokenRoles(`header.${notJson}.sig`)).toEqual([]);
  });
});

describe("decodeAccessTokenUserId", () => {
  test("reads the sub claim out of a well-formed token", () => {
    const token = fakeJwt({ sub: "user-1", roles: ["ORG_ADMIN"] });
    expect(decodeAccessTokenUserId(token)).toBe("user-1");
  });

  test("returns null when the claim is missing", () => {
    const token = fakeJwt({ roles: ["ORG_ADMIN"] });
    expect(decodeAccessTokenUserId(token)).toBeNull();
  });

  test("returns null when the claim is not a non-empty string", () => {
    expect(decodeAccessTokenUserId(fakeJwt({ sub: 42 }))).toBeNull();
    expect(decodeAccessTokenUserId(fakeJwt({ sub: "" }))).toBeNull();
    expect(decodeAccessTokenUserId(fakeJwt({ sub: null }))).toBeNull();
  });

  test("returns null for a malformed token instead of throwing", () => {
    expect(decodeAccessTokenUserId("not-a-jwt")).toBeNull();
    expect(decodeAccessTokenUserId("")).toBeNull();
    expect(decodeAccessTokenUserId("only.two")).toBeNull();
  });
});
