/**
 * QA-023: an access token signed by one API instance is accepted by every other.
 *
 * Production runs several API machines, and a rolling deploy always has two generations live. Each
 * used to generate its own RSA key in memory, with a random kid and a rotation timer, so a token
 * signed on machine A was a 401 on machine B, and every restart logged everyone out. A deployed
 * API now loads its key from JWT_PRIVATE_KEY_PEM, and the kid is the key's thumbprint.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/auth/multi-instance-jwt.test.ts
 */

// Imported before src/middleware -- see the note at the top of tests/auth/support.ts.
import "@hono/zod-openapi";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { exportPKCS8, generateKeyPair } from "jose";

import { createTestApp, createTestDatabase, integrationEnabled, migrateDatabase } from "../harness";
import { createSchoolUnderTest, tokenFor } from "../harness/object-access";

import type { TestApp, TestDatabase } from "../harness";
import type { SchoolUnderTest } from "../harness/object-access";

const describeDb = integrationEnabled ? describe : describe.skip;

let database: TestDatabase | undefined;
let a: TestApp | undefined;
let b: TestApp | undefined;
let stranger: TestApp | undefined;
let school: SchoolUnderTest;

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  school = await createSchoolUnderTest(database.sql);
  const { privateKey } = await generateKeyPair("RS256", { modulusLength: 2048, extractable: true });
  const pem = await exportPKCS8(privateKey);
  const first = createTestApp({ database: database.sql, jwtPrivateKeyPem: pem });
  const second = createTestApp({ database: database.sql, jwtPrivateKeyPem: pem });
  const other = createTestApp({ database: database.sql });
  await Promise.all([first.ready, second.ready, other.ready]);
  [a, b, stranger] = [first, second, other];
}, 60_000);

afterAll(async () => {
  for (const instance of [a, b, stranger]) instance?.keyStore.destroy();
  await database?.cleanup();
});

async function sessionsOn(instance: TestApp, token: string): Promise<number> {
  const response = await instance.app.request("/api/auth/sessions", {
    headers: { Authorization: `Bearer ${token}` },
  });
  return response.status;
}

describeDb("access tokens across API instances (QA-023)", () => {
  test("a token minted on instance A is accepted by instance B", async () => {
    const token = await tokenFor(a!.keyStore, school.schoolId, school.actors.teacherA);
    expect(await sessionsOn(a!, token)).toBe(200);
    expect(await sessionsOn(b!, token)).toBe(200);
  });

  test("a token signed with a key outside the shared secret is still refused", async () => {
    const token = await tokenFor(stranger!.keyStore, school.schoolId, school.actors.teacherA);
    expect(await sessionsOn(a!, token)).toBe(401);
  });

  test("an unsigned (alg=none) token is still refused", async () => {
    const good = await tokenFor(a!.keyStore, school.schoolId, school.actors.teacherA);
    const [, payload] = good.split(".");
    const header = Buffer.from(
      JSON.stringify({ alg: "none", kid: a!.keyStore.signingKey().kid }),
    ).toString("base64url");
    expect(await sessionsOn(b!, `${header}.${payload}.`)).toBe(401);
  });
});
