/**
 * The `entitlements_ver` claim at signing time (ST-133).
 *
 * The claim was hardcoded to 1 at both signing sites before this ticket. These assertions hold the
 * property that makes the staleness check usable rather than a lockout: a freshly minted token always
 * carries the version currently committed, so it can never fail its own first request.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { withTenantTx } from "../../src/db/tenant-tx";
import { KeyStore, AUTH_CHANNELS } from "../../src/modules/auth";
import {
  issueTokenPair,
  rotateRefreshToken,
} from "../../src/modules/auth/services/session-service";
import { bumpEntitlementVersion } from "../../src/modules/subscriptions/entitlements/version";
import {
  createFullTenant,
  createTestDatabase,
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import type { SessionTokenConfig } from "../../src/modules/auth/services/session-service";
import type { TestDatabase } from "../harness";

const integrationTest = test.skipIf(!integrationEnabled);

let db: TestDatabase | undefined;
let keyStore: KeyStore | undefined;

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createTestDatabase({ maxConnections: 8 });
  await migrateDatabase(db.url);
  keyStore = new KeyStore(60_000);
  await keyStore.init();
}, 120_000);

afterAll(async () => {
  keyStore?.destroy();
  await db?.cleanup();
});

function config(): SessionTokenConfig {
  return {
    keyStore: keyStore!,
    issuer: "studafy-test",
    audience: "studafy-api-test",
    accessTtlSeconds: 900,
    refreshTtlSeconds: 3600,
  };
}

function decode(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as Record<
    string,
    unknown
  >;
}

async function mint(schoolId: string, userId: string): Promise<Record<string, unknown>> {
  const pair = await withTenantTx(db!.sql, { schoolId, userId }, (tx) =>
    issueTokenPair(tx, config(), {
      userId,
      schoolId,
      channel: AUTH_CHANNELS.WEB,
    }),
  );
  return decode(pair.accessToken);
}

describe("entitlements_ver at signing", () => {
  // The no-backfill property: a tenant that has never had a subscription change signs the same value
  // every pre-ST-133 token already carries, so nothing is invalidated by deploying this.
  integrationTest("a tenant with no version row signs the genesis version", async () => {
    const tenant = await createFullTenant(db!.sql);

    const claims = await mint(tenant.schoolId, tenant.users.INSTRUCTOR.id);

    expect(claims.entitlements_ver).toBe(1);
  });

  integrationTest("a bumped version is reflected in the next minted token", async () => {
    const tenant = await createFullTenant(db!.sql);

    const version = await withTenantTx(db!.sql, { schoolId: tenant.schoolId }, (tx) =>
      bumpEntitlementVersion(tx, "school", tenant.schoolId),
    );
    expect(version).toBe(2);

    const claims = await mint(tenant.schoolId, tenant.users.INSTRUCTOR.id);

    expect(claims.entitlements_ver).toBe(2);
  });

  // The property that keeps the middleware from locking everyone out: claim >= committed, always.
  // If this ever inverted, every token would fail its own first request and refresh would loop.
  integrationTest("a freshly minted token is never behind the committed version", async () => {
    const tenant = await createFullTenant(db!.sql);

    for (let index = 0; index < 3; index += 1) {
      await withTenantTx(db!.sql, { schoolId: tenant.schoolId }, (tx) =>
        bumpEntitlementVersion(tx, "school", tenant.schoolId),
      );

      const claims = await mint(tenant.schoolId, tenant.users.INSTRUCTOR.id);
      const committed = await withTenantTx(db!.sql, { schoolId: tenant.schoolId }, async (tx) => {
        const [row] = await tx<{ version: string }[]>`
          SELECT version::text AS version FROM app.entitlement_versions
          WHERE school_id = ${tenant.schoolId}::uuid
            AND subject_type = 'school' AND subject_id = ${tenant.schoolId}::uuid
        `;
        return Number(row!.version);
      });

      expect(claims.entitlements_ver).toBe(committed);
    }
  });

  // The version is per school. One tenant's churn must not invalidate another's tokens.
  integrationTest("one tenant's bump does not move another's claim", async () => {
    const first = await createFullTenant(db!.sql);
    const second = await createFullTenant(db!.sql);

    await withTenantTx(db!.sql, { schoolId: first.schoolId }, (tx) =>
      bumpEntitlementVersion(tx, "school", first.schoolId),
    );

    expect((await mint(first.schoolId, first.users.INSTRUCTOR.id)).entitlements_ver).toBe(2);
    expect((await mint(second.schoolId, second.users.INSTRUCTOR.id)).entitlements_ver).toBe(1);
  });

  // readSessionClaims reads both claims in one round trip; the subscription_status claim the
  // lifecycle middleware depends on must not have regressed in the process.
  integrationTest("still signs the subscription status alongside the version", async () => {
    const tenant = await createFullTenant(db!.sql);

    const claims = await mint(tenant.schoolId, tenant.users.INSTRUCTOR.id);

    expect(claims.subscription_status).toBeTruthy();
    expect(typeof claims.subscription_status).toBe("string");
  });
});

// The second signing site. Covered here rather than by extending tests/auth/rotation.test.ts because
// that suite is slow enough to be run on its own; this asserts only the claim ST-133 changed.
describe("entitlements_ver on refresh", () => {
  // The recovery path the 401 points clients at. If refresh did not pick up the new version, a stale
  // token would be rejected and its replacement rejected identically — an unbreakable loop.
  integrationTest("a rotated token carries the version bumped since it was issued", async () => {
    const tenant = await createFullTenant(db!.sql);
    const userId = tenant.users.INSTRUCTOR.id;

    const issued = await withTenantTx(db!.sql, { schoolId: tenant.schoolId, userId }, (tx) =>
      issueTokenPair(tx, config(), {
        userId,
        schoolId: tenant.schoolId,
        channel: AUTH_CHANNELS.WEB,
      }),
    );
    expect(decode(issued.accessToken).entitlements_ver).toBe(1);

    await withTenantTx(db!.sql, { schoolId: tenant.schoolId }, (tx) =>
      bumpEntitlementVersion(tx, "school", tenant.schoolId),
    );

    const rotated = await rotateRefreshToken(db!.sql, config(), {
      presentedToken: issued.refreshToken,
    });

    expect(decode(rotated.accessToken).entitlements_ver).toBe(2);
    // The other tenant-scoped claim still travels with it.
    expect(decode(rotated.accessToken).subscription_status).toBeTruthy();
  });
});
