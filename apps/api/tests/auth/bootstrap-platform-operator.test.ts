/**
 * The first-operator bootstrap (apps/api/scripts/bootstrap-platform-operator.ts) end to end: it
 * creates an active platform school and a SUPER_ADMIN invitation, the app's own activation turns
 * that into a signed-in operator through a verified Google identity, and a second run is refused.
 * Requires a live PostgreSQL instance, gated on TEST_DATABASE_URL.
 */

import { SQL } from "bun";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  bootstrapPlatformOperator,
  PLATFORM_SCHOOL_SLUG,
} from "../../scripts/bootstrap-platform-operator";
import { hashInvitationToken, KeyStore } from "../../src/modules/auth";
import { activateAccount } from "../../src/modules/auth/services/activation-service";
import {
  createTestDatabase,
  integrationEnabled,
  migrateDatabase,
  TEST_JWT_AUDIENCE,
  TEST_JWT_ISSUER,
} from "../harness";

import type { SessionTokenConfig } from "../../src/modules/auth";
import type { TestDatabase } from "../harness";

const describeDb = integrationEnabled ? describe : describe.skip;

let database: TestDatabase | undefined;
let keyStore: KeyStore | undefined;

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  keyStore = new KeyStore(60_000);
  await keyStore.init();
}, 60_000);

afterAll(async () => {
  keyStore?.destroy();
  await database?.cleanup();
});

describeDb("bootstrap-platform-operator", () => {
  test("creates the platform school and an invitation that activates a SUPER_ADMIN, once", async () => {
    const sql = database!.sql;
    // Bun's built-in client, the one the script uses inside the production container.
    const bunSql = new SQL({ url: database!.url, max: 1 });
    const result = await bootstrapPlatformOperator(bunSql, {
      email: "Founder@Example.test",
      frontendUrl: "https://app.studafy.com/",
    });

    expect(result.createdSchool).toBe(true);
    expect(result.link).toBe(`https://app.studafy.com/invite/${result.token}`);
    // Only the hash is stored, and it is the one the app looks invitations up by.
    const [stored] = await database!.sql<{ token_hash: Buffer }[]>`
      SELECT token_hash FROM app.invitations WHERE id = ${result.invitationId}
    `;
    expect(stored!.token_hash.equals(hashInvitationToken(result.token))).toBe(true);

    const [school] = await sql<{ slug: string; status: string; is_platform_tenant: boolean }[]>`
      SELECT slug, status::text AS status, is_platform_tenant
      FROM app.schools WHERE id = ${result.schoolId}
    `;
    expect(school).toEqual({
      slug: PLATFORM_SCHOOL_SLUG,
      status: "active",
      is_platform_tenant: true,
    });

    const config: SessionTokenConfig = {
      keyStore: keyStore!,
      issuer: TEST_JWT_ISSUER,
      audience: TEST_JWT_AUDIENCE,
      accessTtlSeconds: 900,
      refreshTtlSeconds: 30 * 24 * 60 * 60,
    };
    const activated = await activateAccount(sql, config, {
      rawToken: result.token,
      // The email arrives lower-cased from the provider; the invitation matches it case-insensitively.
      identity: { provider: "google", subject: "google-sub-1", email: "founder@example.test" },
      channel: "web",
    });
    expect(activated.outcome).toBe("ACTIVATED");

    const roles = await sql<{ role: string }[]>`
      SELECT ur.role::text AS role
      FROM app.user_roles AS ur
      JOIN app.oauth_identities AS oi ON oi.user_id = ur.user_id AND oi.school_id = ur.school_id
      WHERE ur.school_id = ${result.schoolId} AND oi.provider = 'google' AND oi.subject = 'google-sub-1'
    `;
    expect(roles.map((row) => row.role)).toEqual(["SUPER_ADMIN"]);

    await expect(
      bootstrapPlatformOperator(bunSql, { email: "someone@example.test", frontendUrl: "x" }),
    ).rejects.toThrow("A SUPER_ADMIN already exists");
    await bunSql.close();
  });
});
