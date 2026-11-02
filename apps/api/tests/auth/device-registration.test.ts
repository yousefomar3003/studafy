/**
 * Registering a push token (POST /api/auth/devices -> registerDeviceToken) against a real database.
 *
 * The app registers its FCM token more than once around sign-in and the notification permission
 * prompt, and those calls can overlap. CURRENT_TIMESTAMP is a transaction's *start* time, so a
 * registration that began before a concurrent one inserted the row could stamp `last_seen` earlier
 * than that row's `created_at` and fail ck_user_devices_last_seen -- a 500 seen on a real emulator.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { withTenantTx } from "../../src/db/tenant-tx";
import { registerDeviceToken } from "../../src/modules/auth/services/session-service";
import {
  createFullTenant,
  createTestDatabase,
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import type { TenantFixture, TestDatabase } from "../harness";

const integrationTest = test.skipIf(!integrationEnabled);

let database: TestDatabase | undefined;
let tenant: TenantFixture;

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  tenant = await createFullTenant(database.sql);
}, 60_000);

afterAll(async () => {
  await database?.cleanup();
});

describe("registerDeviceToken", () => {
  integrationTest("an overlapping re-registration of the same token succeeds", async () => {
    const user = tenant.users.PARENT;
    const context = { schoolId: tenant.schoolId, userId: user.id };
    const token = `fcm-token-${crypto.randomUUID()}`;

    // The first registration's transaction starts (its CURRENT_TIMESTAMP is fixed here)...
    const first = withTenantTx(database!.sql, context, async (tx) => {
      await tx`SELECT 1`;
      // ...while a second registration inserts the row and commits, with a later created_at...
      await withTenantTx(database!.sql, context, (other) =>
        registerDeviceToken(other, user.id, tenant.schoolId, token, "android"),
      );
      // ...and only then does the first one upsert the same token.
      return registerDeviceToken(tx, user.id, tenant.schoolId, token, "android");
    });

    await expect(first).resolves.toMatchObject({ id: expect.any(String) });

    const rows = await withTenantTx(
      database!.sql,
      context,
      (tx) => tx<{ ok: boolean }[]>`
      SELECT last_seen >= created_at AND updated_at >= created_at AS ok
      FROM app.user_devices WHERE fcm_token = ${token}
    `,
    );
    expect([...rows]).toEqual([{ ok: true }]);
  });

  integrationTest("re-registering later refreshes last_seen", async () => {
    const user = tenant.users.STUDENT;
    const context = { schoolId: tenant.schoolId, userId: user.id };
    const token = `fcm-token-${crypto.randomUUID()}`;

    const { id } = await withTenantTx(database!.sql, context, (tx) =>
      registerDeviceToken(tx, user.id, tenant.schoolId, token, "android"),
    );
    const [before] = await withTenantTx(
      database!.sql,
      context,
      (tx) => tx<{ last_seen: Date }[]>`
      SELECT last_seen FROM app.user_devices WHERE id = ${id}::uuid
    `,
    );
    await Bun.sleep(20);
    const again = await withTenantTx(database!.sql, context, (tx) =>
      registerDeviceToken(tx, user.id, tenant.schoolId, token, "ios"),
    );
    const [after] = await withTenantTx(
      database!.sql,
      context,
      (tx) => tx<{ last_seen: Date; platform: string }[]>`
      SELECT last_seen, platform::text AS platform FROM app.user_devices WHERE id = ${id}::uuid
    `,
    );

    expect(again.id).toBe(id);
    expect(after!.last_seen.getTime()).toBeGreaterThan(before!.last_seen.getTime());
    expect(after!.platform).toBe("ios");
  });
});
