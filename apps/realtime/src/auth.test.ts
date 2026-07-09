// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { signToken, TokenVerificationError, verifyToken } from "./auth";

const SECRET = "test-secret";

describe("signToken / verifyToken", () => {
  test("round-trips claims through a valid token", () => {
    const token = signToken({ sub: "user-1", schoolId: "school-1", role: "STUDENT" }, SECRET);
    expect(verifyToken(token, SECRET)).toEqual({
      userId: "user-1",
      schoolId: "school-1",
      role: "STUDENT",
    });
  });

  test("rejects a token signed with a different secret", () => {
    const token = signToken({ sub: "user-1", schoolId: "school-1", role: "STUDENT" }, SECRET);
    expect(() => verifyToken(token, "wrong-secret")).toThrow(TokenVerificationError);
  });

  test("rejects a tampered payload", () => {
    const token = signToken({ sub: "user-1", schoolId: "school-1", role: "STUDENT" }, SECRET);
    const [header, , signature] = token.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({ sub: "attacker", schoolId: "school-1", role: "SUPER_ADMIN" }),
    ).toString("base64url");

    expect(() => verifyToken(`${header}.${tamperedPayload}.${signature}`, SECRET)).toThrow(
      TokenVerificationError,
    );
  });

  test("rejects a token that is missing a segment", () => {
    expect(() => verifyToken("header.payload", SECRET)).toThrow(TokenVerificationError);
  });

  test("rejects a token with an invalid role", () => {
    const token = signToken(
      // @ts-expect-error -- deliberately invalid role to exercise claims validation
      { sub: "user-1", schoolId: "school-1", role: "NOT_A_ROLE" },
      SECRET,
    );
    expect(() => verifyToken(token, SECRET)).toThrow(TokenVerificationError);
  });

  test("rejects an expired token", () => {
    const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;
    const token = signToken(
      { sub: "user-1", schoolId: "school-1", role: "STUDENT", exp: oneHourAgo },
      SECRET,
    );
    expect(() => verifyToken(token, SECRET)).toThrow(TokenVerificationError);
  });

  test("accepts a token that has not yet expired", () => {
    const oneHourFromNow = Math.floor(Date.now() / 1000) + 3600;
    const token = signToken(
      { sub: "user-1", schoolId: "school-1", role: "STUDENT", exp: oneHourFromNow },
      SECRET,
    );
    expect(() => verifyToken(token, SECRET)).not.toThrow();
  });
});
