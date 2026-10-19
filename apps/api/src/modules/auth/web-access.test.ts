// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { isWebSessionRefused, mobileOnlyWebException } from "./web-access";

describe("isWebSessionRefused", () => {
  test.each([["STUDENT"], ["PARENT"], ["INSTRUCTOR"], ["ATTENDANCE_OFFICER"]])(
    "refuses a web session for %s",
    (role) => {
      expect(isWebSessionRefused("web", [role])).toBe(true);
    },
  );

  test("lets the same roles sign in on mobile", () => {
    expect(isWebSessionRefused("mobile", ["STUDENT"])).toBe(false);
    expect(isWebSessionRefused("mobile", ["INSTRUCTOR", "PARENT"])).toBe(false);
  });

  test("keeps web access for anyone who also holds a web role", () => {
    expect(isWebSessionRefused("web", ["INSTRUCTOR", "ORG_ADMIN"])).toBe(false);
    expect(isWebSessionRefused("web", ["PRINCIPAL"])).toBe(false);
  });

  test("answers with a 403 the web error page recognises", () => {
    const error = mobileOnlyWebException();
    expect(error.status).toBe(403);
    expect(error.code).toBe("WEB_ACCESS_MOBILE_ONLY");
  });
});
