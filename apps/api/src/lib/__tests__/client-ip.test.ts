// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { resetSecurityConfig } from "../../config/security";
import { clientIpFrom } from "../client-ip";

function request(headers: Record<string, string>) {
  return { req: { header: (name: string) => headers[name] } };
}

describe("clientIpFrom behind fly.io (CLIENT_IP_HEADER=fly-client-ip)", () => {
  beforeEach(() => {
    process.env.CLIENT_IP_HEADER = "Fly-Client-IP";
    resetSecurityConfig();
  });
  afterEach(() => {
    delete process.env.CLIENT_IP_HEADER;
    resetSecurityConfig();
  });

  test("uses the visitor address fly vouches for, never the comma-separated X-Forwarded-For", () => {
    // The production failure: the raw header reached an inet column and failed the sign-in.
    const ip = clientIpFrom(
      request({
        "fly-client-ip": "151.247.101.16",
        "x-forwarded-for": "151.247.101.16, 66.241.125.144",
      }),
    );
    expect(ip).toBe("151.247.101.16");
  });

  test("falls back to the first X-Forwarded-For hop when the trusted header is missing", () => {
    expect(clientIpFrom(request({ "x-forwarded-for": "203.0.113.7, 66.241.125.144" }))).toBe(
      "203.0.113.7",
    );
  });
});

describe("clientIpFrom without a trusted header", () => {
  beforeEach(() => resetSecurityConfig());

  test("takes the first X-Forwarded-For hop", () => {
    expect(clientIpFrom(request({ "x-forwarded-for": "2001:db8::1, 10.0.0.1" }))).toBe(
      "2001:db8::1",
    );
  });

  test("falls back to X-Real-IP", () => {
    expect(clientIpFrom(request({ "x-real-ip": "198.51.100.4" }))).toBe("198.51.100.4");
  });

  test("returns null for anything that is not one address, so the inet insert cannot fail", () => {
    expect(clientIpFrom(request({}))).toBeNull();
    expect(clientIpFrom(request({ "x-forwarded-for": "" }))).toBeNull();
    expect(clientIpFrom(request({ "x-forwarded-for": "not-an-ip" }))).toBeNull();
    expect(clientIpFrom(request({ "x-real-ip": "1.2.3.4, 5.6.7.8" }))).toBeNull();
  });
});
