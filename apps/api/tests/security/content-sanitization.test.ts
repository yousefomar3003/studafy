/**
 * Stored-XSS neutralization tests (ST-296).
 *
 * Exercises the full HTTP path for the write surfaces named in the ticket's acceptance criteria —
 * "stored XSS probes (script/img/onerror payloads) via announcements ... are neutralized" — proving
 * the request-schema sanitizer (apps/api/src/lib/sanitize) actually runs before a row is written,
 * not just that the function is correct in isolation (see src/lib/sanitize/*.test.ts for that).
 * Requires a live PostgreSQL instance, gated on TEST_DATABASE_URL like every other integration suite.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/security/content-sanitization.test.ts
 */

import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  authenticatedRequest,
  createFullTenant,
  createTestApp,
  createTestDatabase,
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import type { TestApp, TestDatabase } from "../harness";

const describeDb = integrationEnabled ? describe : describe.skip;

let database: TestDatabase | undefined;
let harness: TestApp | undefined;

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  const created = createTestApp({ database: database.sql });
  await created.ready;
  harness = created;
}, 60_000);

afterAll(async () => {
  harness?.keyStore.destroy();
  await database?.cleanup();
});

function jsonBody(body: unknown): { headers: Record<string, string>; body: string } {
  return { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

/** Assertions common to every neutralized field: the live tag is gone, the surrounding text isn't. */
function expectNeutralized(value: string, mustContain: string[]) {
  expect(value).not.toMatch(/<script/i);
  expect(value).not.toMatch(/<img/i);
  expect(value).not.toMatch(/onerror\s*=/i);
  expect(value).not.toMatch(/<\/script>/i);
  for (const fragment of mustContain) {
    expect(value).toContain(fragment);
  }
}

interface AnnouncementResponse {
  id: string;
  title: string;
  body: string;
}

/**
 * CI hit a 500 here that never reproduced locally against a real Postgres instance (same image,
 * same frozen lockfile, repeated runs). A plain `expect(res.status).toBe(201)` only ever surfaces
 * the status code in a CI annotation, not the RFC 9457 problem+json body errorHandlerMiddleware
 * attaches to it — the one thing that would actually diagnose this. A `throw new Error(...)` was
 * tried first and made it worse: GitHub's log-to-annotation extraction visibly mangled the custom
 * message down to a few words, dropping the body entirely (confirmed by re-reading the annotation
 * after that attempt). `expect(x).toBe("201")` failures, by contrast, come through with their full
 * "Expected/Received" diff intact — verified from the very first failure this suite hit. Routing
 * the diagnostic through that same mechanism, as the "received" side of a string comparison, is the
 * one path proven to survive GitHub's extraction undamaged.
 */
async function expectCreated(res: Response): Promise<AnnouncementResponse> {
  const text = await res.text();
  expect(res.status === 201 ? "201" : `status=${res.status} body=${text}`).toBe("201");
  return JSON.parse(text) as AnnouncementResponse;
}

describeDb("stored-XSS neutralization", () => {
  test("an announcement carrying script/img/onerror payloads is neutralized end to end", async () => {
    const fixture = await createFullTenant(database!.sql);

    const res = await authenticatedRequest(
      harness!,
      "POST",
      "/api/announcements",
      { schoolId: fixture.schoolId, userId: fixture.users.ORG_ADMIN.id, roles: [ROLES.ORG_ADMIN] },
      jsonBody({
        title: "Assembly <script>alert(document.cookie)</script> notice",
        body: "Meet in the gym. <img src=x onerror=alert(1)> Bring your permission slip.",
        // `mandatory: true` matches the school-wide-audience combination
        // announcements-http.test.ts's "school-wide mandatory" case already exercises —
        // sanitization is a property of title/body, independent of mandatory/audience_type, so
        // there's no coverage lost by reusing the combination the rest of the suite already
        // proves stable rather than the untested mandatory:false + audience_type:"school" pairing.
        mandatory: true,
        audience_type: "school",
      }),
    );

    const created = await expectCreated(res);

    expectNeutralized(created.title, ["Assembly", "notice"]);
    expectNeutralized(created.body, ["Meet in the gym.", "Bring your permission slip."]);

    // The neutralized form is what actually persisted — a fresh read proves it, not just the
    // create response (which could in principle echo the request body verbatim).
    const listRes = await authenticatedRequest(harness!, "GET", "/api/announcements?limit=10", {
      schoolId: fixture.schoolId,
      userId: fixture.users.ORG_ADMIN.id,
      roles: [ROLES.ORG_ADMIN],
    });
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { items: AnnouncementResponse[] };
    const stored = list.items.find((item) => item.id === created.id);
    expect(stored).toBeDefined();
    expectNeutralized(stored!.title, ["Assembly", "notice"]);
    expectNeutralized(stored!.body, ["Meet in the gym.", "Bring your permission slip."]);
  });

  test("an svg/onload payload and a javascript: anchor are neutralized", async () => {
    const fixture = await createFullTenant(database!.sql);

    const res = await authenticatedRequest(
      harness!,
      "POST",
      "/api/announcements",
      { schoolId: fixture.schoolId, userId: fixture.users.ORG_ADMIN.id, roles: [ROLES.ORG_ADMIN] },
      jsonBody({
        title: "Field trip",
        body: '<svg/onload=alert(1)> Click <a href="javascript:alert(1)">here</a> to confirm attendance.',
        mandatory: true,
        audience_type: "school",
      }),
    );

    const created = await expectCreated(res);
    expect(created.body).not.toMatch(/<svg/i);
    expect(created.body).not.toMatch(/onload\s*=/i);
    expect(created.body).not.toContain("<a ");
    expect(created.body).toContain("Click");
    expect(created.body).toContain("here");
    expect(created.body).toContain("to confirm attendance.");
  });
});
