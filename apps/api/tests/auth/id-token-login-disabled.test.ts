/**
 * QA-025: the bare ID-token login is not reachable in a deployed API.
 *
 * `POST /api/auth/login/oauth` exchanged any Studafy-audience Google/Microsoft ID token for a full
 * session, with a nonce the client itself supplied (it is plaintext in the token), bound to no
 * server-issued state and with no replay check: a token lifted from a log, an extension or an XSS
 * on a page using the same client id was a session for its remaining hour. No web or mobile client
 * calls it; they sign in through the server-side callback and mobile-exchange flows, which bind
 * state and nonce on the server. The route is now mounted only when a caller explicitly opts in
 * (`idTokenLoginEnabled`), which only the tests of the shared returning-user login policy do.
 */

// Imported before src/middleware -- see the note at the top of tests/auth/support.ts.
import "@hono/zod-openapi";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, describe, expect, test } from "bun:test";

import { createApp } from "../../src/app";
import { createInflightTracker } from "../../src/lifecycle";
import { createLogger } from "../../src/logger";
import { KeyStore } from "../../src/modules/auth";
import { buildOpenApiDocument } from "../../src/openapi/document";

const keyStore = new KeyStore(60_000);
afterAll(() => keyStore.destroy());

describe("ID-token login is off by default (QA-025)", () => {
  test("a default app does not mount POST /api/auth/login/oauth", async () => {
    await keyStore.init();
    const app = createApp({
      isReady: () => true,
      tracker: createInflightTracker(),
      logger: createLogger({ destination: () => undefined }),
      // A placeholder: the route needs database and keyStore to be mounted at all.
      database: {} as never,
      keyStore,
    });
    // The route table, not a status code: an unconfigured provider also answers 404.
    const mounted = app.routes.filter((route) => route.path === "/api/auth/login/oauth");
    expect(mounted).toEqual([]);
  });

  test("the published API document does not offer it", async () => {
    const document = await buildOpenApiDocument();
    expect(Object.keys(document.paths ?? {})).not.toContain("/api/auth/login/oauth");
  });
});
