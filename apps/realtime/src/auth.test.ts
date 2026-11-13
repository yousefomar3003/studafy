// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { signToken, ticketPayload, TokenVerificationError, verifyToken } from "./auth";

import type { TicketPayload } from "./auth";

const SECRET = "test-secret";
const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);
const NOW_S = NOW / 1000;

function ticket(overrides: Partial<TicketPayload> = {}, secret = SECRET): string {
  return signToken(
    ticketPayload({ sub: "user-1", school_id: "school-1", roles: ["STUDENT"], ...overrides }, NOW),
    secret,
  );
}

function failure(token: string, nowMs = NOW): TokenVerificationError {
  try {
    verifyToken(token, SECRET, nowMs);
  } catch (error) {
    expect(error).toBeInstanceOf(TokenVerificationError);
    return error as TokenVerificationError;
  }
  throw new Error("expected verifyToken to throw");
}

describe("verifyToken", () => {
  test("returns the session the ticket names", () => {
    const token = ticket({ sid: "sess-1", sexp: NOW_S + 900, jti: "ticket-1" });
    expect(verifyToken(token, SECRET, NOW)).toEqual({
      userId: "user-1",
      schoolId: "school-1",
      roles: ["STUDENT"],
      sessionId: "sess-1",
      sessionExp: NOW_S + 900,
      ticketId: "ticket-1",
      exp: NOW_S + 30,
    });
  });

  test("rejects a ticket signed with a different secret", () => {
    expect(failure(ticket({}, "wrong-secret")).message).toContain("invalid signature");
  });

  test("rejects a tampered payload", () => {
    const [header, , signature] = ticket().split(".");
    const forged = Buffer.from(
      JSON.stringify(
        ticketPayload({ sub: "attacker", school_id: "school-1", roles: ["SUPER_ADMIN"] }, NOW),
      ),
    ).toString("base64url");
    expect(failure(`${header}.${forged}.${signature}`).code).toBe("TOKEN_INVALID");
  });

  test("rejects a header naming another algorithm", () => {
    const [, payload, signature] = ticket().split(".");
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    expect(failure(`${header}.${payload}.${signature}`).message).toContain("unsupported algorithm");
  });

  test("rejects a token that is missing a segment", () => {
    expect(failure("header.payload").code).toBe("TOKEN_INVALID");
  });

  test("rejects a ticket addressed to another audience, such as the API's access tokens", () => {
    expect(failure(ticket({ aud: "studafy-api" })).code).toBe("TOKEN_INVALID");
  });

  test("rejects a ticket from another issuer", () => {
    expect(failure(ticket({ iss: "someone-else" })).code).toBe("TOKEN_INVALID");
  });

  test("rejects an unknown role and an empty role list", () => {
    // @ts-expect-error -- deliberately invalid role to exercise claims validation
    expect(failure(ticket({ roles: ["NOT_A_ROLE"] })).code).toBe("TOKEN_INVALID");
    expect(failure(ticket({ roles: [] })).code).toBe("TOKEN_INVALID");
  });

  test.each(["sid", "sexp", "jti", "iat", "exp"] as const)("requires the %s claim", (claim) => {
    const payload: Record<string, unknown> = ticketPayload(
      { sub: "user-1", school_id: "school-1", roles: ["STUDENT"] },
      NOW,
    ) as never;
    delete payload[claim];
    expect(failure(signToken(payload as never, SECRET)).code).toBe("TOKEN_INVALID");
  });

  test("rejects a ticket issued for longer than 60 seconds", () => {
    expect(failure(ticket({ iat: NOW_S, exp: NOW_S + 61 })).message).toContain(
      "lifetime exceeds the maximum",
    );
    expect(() => verifyToken(ticket({ iat: NOW_S, exp: NOW_S + 60 }), SECRET, NOW)).not.toThrow();
  });

  test("rejects a ticket issued in the future beyond the allowed skew", () => {
    expect(failure(ticket({ iat: NOW_S + 10, exp: NOW_S + 40 })).message).toContain("future");
    expect(() =>
      verifyToken(ticket({ iat: NOW_S + 5, exp: NOW_S + 35 }), SECRET, NOW),
    ).not.toThrow();
  });

  test("an expired ticket, or a ticket for an expired session, carries TOKEN_EXPIRED", () => {
    expect(failure(ticket(), NOW + 30_000).code).toBe("TOKEN_EXPIRED");
    expect(failure(ticket({ sexp: NOW_S })).code).toBe("TOKEN_EXPIRED");
  });

  test("the error message never contains the ticket", () => {
    const token = ticket({}, "wrong-secret");
    expect(failure(token).message).not.toContain(token.split(".")[2]);
  });
});

describe("verifyToken performance", () => {
  test("p95 verification latency stays under the connection auth budget", () => {
    const token = ticket();
    const iterations = 1000;
    const durations: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      verifyToken(token, SECRET, NOW);
      durations.push(performance.now() - start);
    }

    durations.sort((a, b) => a - b);
    const p95 = durations[Math.floor(iterations * 0.95)];

    // The 100ms p95 acceptance budget covers the whole connection (network + upgrade + this
    // check); ticket verification itself is synchronous HMAC + JSON parsing with no I/O, so it
    // must stay far under that to leave headroom for the rest of the handshake.
    expect(p95).toBeLessThan(10);
  });
});
