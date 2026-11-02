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
    expect(verifyToken(token, SECRET).exp).toBe(oneHourFromNow);
  });

  test("expired token carries TOKEN_EXPIRED, everything else carries TOKEN_INVALID", () => {
    const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;
    const expiredToken = signToken(
      { sub: "user-1", schoolId: "school-1", role: "STUDENT", exp: oneHourAgo },
      SECRET,
    );
    try {
      verifyToken(expiredToken, SECRET);
      throw new Error("expected verifyToken to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(TokenVerificationError);
      expect((error as TokenVerificationError).code).toBe("TOKEN_EXPIRED");
    }

    try {
      verifyToken("not-a-jwt", SECRET);
      throw new Error("expected verifyToken to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(TokenVerificationError);
      expect((error as TokenVerificationError).code).toBe("TOKEN_INVALID");
    }
  });
});

describe("verifyToken performance", () => {
  test("p95 verification latency stays under the connection auth budget", () => {
    const token = signToken({ sub: "user-1", schoolId: "school-1", role: "STUDENT" }, SECRET);
    const iterations = 1000;
    const durations: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      verifyToken(token, SECRET);
      durations.push(performance.now() - start);
    }

    durations.sort((a, b) => a - b);
    const p95 = durations[Math.floor(iterations * 0.95)];

    // The 100ms p95 acceptance budget covers the whole connection (network + upgrade + this
    // check); token verification itself is synchronous HMAC + JSON parsing with no I/O, so it
    // must stay far under that to leave headroom for the rest of the handshake.
    expect(p95).toBeLessThan(10);
  });
});
