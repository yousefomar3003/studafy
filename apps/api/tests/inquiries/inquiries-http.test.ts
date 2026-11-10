/**
 * The public "Talk to us" form (`POST /api/inquiries`): a phone number is required, so the sales
 * team can call a school back, and has to look like one. Turnstile accepts any token when no secret
 * key is configured, as in this harness. Requires a live PostgreSQL instance, gated on
 * TEST_DATABASE_URL.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/inquiries/inquiries-http.test.ts
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestApp, createTestDatabase, integrationEnabled, migrateDatabase } from "../harness";

import type { TestApp, TestDatabase } from "../harness";

const describeDb = integrationEnabled ? describe : describe.skip;

let database: TestDatabase | undefined;
let harness: TestApp | undefined;

beforeAll(async () => {
  if (!integrationEnabled) return;
  delete process.env.TURNSTILE_SECRET_KEY;
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

function submit(body: Record<string, unknown>) {
  return harness!.app.request("/api/inquiries", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": crypto.randomUUID() },
    body: JSON.stringify(body),
  });
}

const VALID = {
  full_name: "Sara Al-Ahmad",
  email: "sara@school.example",
  school_name: "Al Noor International",
  captcha_token: "test-token",
};

describeDb("POST /api/inquiries", () => {
  test("refuses an inquiry without a phone number", async () => {
    const response = await submit(VALID);
    expect(response.status).toBe(400);
    const blank = await submit({ ...VALID, phone: "   " });
    expect(blank.status).toBe(400);
  });

  test("refuses a phone number that is not one", async () => {
    for (const phone of ["call me", "12345", "+1 (555) 0100 0000 0000 0000 00", "07-ab-12345"]) {
      const response = await submit({ ...VALID, phone });
      expect(`${phone} -> ${response.status}`).toBe(`${phone} -> 400`);
    }
  });

  test("records an inquiry with a phone number as typed", async () => {
    const response = await submit({ ...VALID, phone: " +962 (7) 9123-4567 " });
    expect(response.status).toBe(201);
    const [row] = await database!.sql<{ phone: string }[]>`
      SELECT phone FROM app.sales_inquiries WHERE email = ${VALID.email} ORDER BY created_at DESC LIMIT 1
    `;
    expect(row?.phone).toBe("+962 (7) 9123-4567");
  });
});
