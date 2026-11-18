// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { describe, expect, test } from "bun:test";

import { HOST_SESSION_COOKIE_NAME, sessionCookieNameFor } from "./security";

// QA-070: a sibling *.studafy.com origin could set a `session` cookie over the API's own (login
// CSRF). A `__Host-` cookie can only be set Secure, Path=/ and without Domain, by the host itself.
describe("refresh cookie name (QA-070)", () => {
  test("deployed tiers use the __Host- prefix", () => {
    expect(sessionCookieNameFor("production")).toBe(HOST_SESSION_COOKIE_NAME);
    expect(sessionCookieNameFor("staging")).toBe("__Host-session");
  });

  test("local development and tests, which have no TLS, keep the plain name", () => {
    expect(sessionCookieNameFor("development")).toBe("session");
    expect(sessionCookieNameFor("test")).toBe("session");
  });
});
