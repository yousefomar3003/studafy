/**
 * QA-007: public school self-registration must never hand its one-time tokens back to the caller.
 *
 * `POST /api/schools/register` is anonymous. If its response carries the email-verification token,
 * the caller can verify a school contact address they do not own (`GET
 * /api/schools/verify-email/{token}` flips the school to `active` and starts provisioning). If it
 * carries the admin invitation token, they can activate the first ORG_ADMIN account with an
 * identity of their choosing. Together that let anyone stand up an active school under a real
 * school's name and email. Both tokens are delivered by email only (the outbox events
 * `school.verificationEmailSent` and `invitation.sent`), which is what proves control of the
 * address.
 *
 * Requires a live PostgreSQL instance, gated on TEST_DATABASE_URL:
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/tenancy/registration-no-token-leak.test.ts
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { IP_SCOPED_ROUTE_CLASSES, resolveRouteClass } from "../../src/config/rateLimits";
import { createTestApp, createTestDatabase, integrationEnabled, migrateDatabase } from "../harness";

import type { TestApp, TestDatabase } from "../harness";

const describeDb = integrationEnabled ? describe : describe.skip;

let database: TestDatabase | undefined;
let harness: TestApp | undefined;
let countryId: string;
let currencyId: string;

beforeAll(async () => {
  if (!integrationEnabled) return;
  // No Turnstile secret: captcha is skipped, as in development (deployed tiers refuse to boot
  // without one -- env.ts). That keeps this test about the response body alone.
  delete process.env.TURNSTILE_SECRET_KEY;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  const [reference] = await database.sql<{ country: string; currency: string }[]>`
    SELECT
      (SELECT id FROM app.countries WHERE alpha2_code = 'US') AS country,
      (SELECT id FROM app.currencies WHERE code = 'USD') AS currency
  `;
  countryId = reference!.country;
  currencyId = reference!.currency;
  const created = createTestApp({ database: database.sql });
  await created.ready;
  harness = created;
}, 60_000);

afterAll(async () => {
  harness?.keyStore.destroy();
  await database?.cleanup();
});

function register(unique: string) {
  return harness!.app.request("/api/schools/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": crypto.randomUUID() },
    body: JSON.stringify({
      school_name: `Real School ${unique}`,
      slug: `real-school-${unique}`,
      email: `office+${unique}@realschool.example`,
      country_id: countryId,
      default_currency_id: currencyId,
      admin_email: `attacker+${unique}@attacker.example`,
      captcha_token: "test-token",
    }),
  });
}

/** Every key path in a JSON value whose key mentions a token, e.g. `verification.token`. */
function tokenKeyPaths(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return [...(/token/i.test(key) ? [path] : []), ...tokenKeyPaths(child, path)];
  });
}

/** Every string anywhere in a JSON value. */
function allStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object") return [];
  return Object.values(value as Record<string, unknown>).flatMap(allStrings);
}

describe("school registration abuse budget (QA-007)", () => {
  test("register, verify and resend share the strictest per-IP class", () => {
    for (const path of [
      "/api/schools/register",
      "/api/schools/verify-email/abc",
      "/api/schools/resend-verification",
    ]) {
      expect(`${path} -> ${resolveRouteClass(path)}`).toBe(`${path} -> auth-strict`);
    }
    expect(IP_SCOPED_ROUTE_CLASSES.has("auth-strict")).toBe(true);
  });
});

describeDb("POST /api/schools/register (QA-007)", () => {
  test("the response carries no token field at any depth", async () => {
    const response = await register(crypto.randomUUID().slice(0, 8));
    expect(response.status).toBe(201);
    const body: unknown = await response.json();

    expect(tokenKeyPaths(body)).toEqual([]);
  });

  test("the emailed verification and invitation tokens never appear in the response", async () => {
    const unique = crypto.randomUUID().slice(0, 8);
    const response = await register(unique);
    expect(response.status).toBe(201);
    const body = (await response.json()) as { school: { id: string; status: string } };
    expect(body.school.status).toBe("registered");

    // The real tokens exist only in the outbox, on their way to the two inboxes.
    const emailed = await database!.sql<{ event_name: string; token: string }[]>`
      SELECT event_name, payload->>'token' AS token
      FROM app.outbox_events
      WHERE school_id = ${body.school.id}
        AND event_name IN ('school.verificationEmailSent', 'invitation.sent')
      ORDER BY event_name
    `;
    expect(emailed.map((row) => row.event_name)).toEqual([
      "invitation.sent",
      "school.verificationEmailSent",
    ]);

    const strings = allStrings(body);
    for (const { event_name, token } of emailed) {
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      expect(`${event_name} in response: ${strings.includes(token)}`).toBe(
        `${event_name} in response: false`,
      );
    }
  });

  test("without the emailed token the school cannot be verified into active", async () => {
    const response = await register(crypto.randomUUID().slice(0, 8));
    const body = (await response.json()) as { school: { id: string } };

    for (const guess of ["", "undefined", "0".repeat(64), body.school.id]) {
      const verify = await harness!.app.request(
        `/api/schools/verify-email/${encodeURIComponent(guess)}`,
      );
      expect(`${JSON.stringify(guess)} -> ${verify.ok}`).toBe(`${JSON.stringify(guess)} -> false`);
    }

    const [school] = await database!.sql<{ status: string }[]>`
      SELECT status FROM app.schools WHERE id = ${body.school.id}
    `;
    expect(school?.status).toBe("registered");
  });
});
