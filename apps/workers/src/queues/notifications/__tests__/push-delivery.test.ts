/**
 * Push delivery (ST-139).
 *
 * The unit tests cover the sender's classification and payload building and always run. The
 * guarantees that actually matter — that a dispatched push advances the dispatch log only when FCM
 * accepted it, that unregistered tokens are revoked, that the per-user cap bounds the fan-out —
 * are about rows in app.user_devices and app.notification_dispatch_logs. Those need a real database,
 * so this suite follows the packages/db/tests convention: skip unless TEST_DATABASE_URL is set, run
 * against a disposable database, assert against real rows.
 *
 * The push sender is a stub: the delivery worker should never be on the line to Firebase in a test,
 * and the worker's honest-delivery logic is what is under test, not FCM.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { MAX_DEVICES_PER_USER, processNotificationDelivery } from "../delivery.worker";
import { resetMetrics, snapshot } from "../push";

import type { PushDevice, PushMessage, PushSender, PushSendResult } from "../push";
import type { Sql } from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

let sql: Sql;

beforeAll(() => {
  if (!databaseUrl) return;
  sql = postgres(databaseUrl, { max: 4, idle_timeout: 20, prepare: false });
});

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
});

beforeEach(() => {
  resetMetrics();
});

interface Fixture {
  schoolId: string;
  userId: string;
  dispatchLogId: string;
  devices: { id: string; token: string }[];
}

let fixtureSeq = 0;

/**
 * A school with one user, one live device per entry in `tokens`, and one dispatch-log row at
 * `enqueued` — exactly what a dispatcher fan-out leaves behind for the delivery worker to finish.
 *
 * `last_seen` is staggered newest-first so the per-user cap is deterministic: the device for
 * `tokens[0]` is the most recently seen, `tokens[1]` the next, and so on.
 */
async function seedPushFixture(tokens: string[]): Promise<Fixture> {
  fixtureSeq += 1;
  const tag = `push${fixtureSeq}-${Date.now().toString(36)}`;

  return await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");

    const [reference] = await tx<{ country: string; currency: string }[]>`
      SELECT
        (SELECT id FROM app.countries WHERE alpha2_code = 'US') AS country,
        (SELECT id FROM app.currencies WHERE code = 'USD') AS currency
    `;
    const schoolEmail = `${tag}@admin.local`;
    const [school] = await tx<{ id: string }[]>`
      INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
      VALUES (${tag}, ${`Push ${tag}`}, ${schoolEmail}, ${schoolEmail},
              ${reference!.country}, ${reference!.currency})
      RETURNING id
    `;
    const schoolId = school!.id;
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;

    const [user] = await tx<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
      VALUES (${schoolId}::uuid, ${`u-${tag}@t.local`}, ${`u-${tag}@t.local`}, 'Parent', 'active')
      RETURNING id
    `;
    const userId = user!.id;

    const devices: { id: string; token: string }[] = [];
    for (const [index, token] of tokens.entries()) {
      const [device] = await tx<{ id: string }[]>`
        INSERT INTO app.user_devices (school_id, user_id, fcm_token, platform, last_seen)
        VALUES (${schoolId}::uuid, ${userId}::uuid, ${token}, 'android',
                CURRENT_TIMESTAMP - (${index} * interval '1 minute'))
        RETURNING id
      `;
      devices.push({ id: device!.id, token });
    }

    const [log] = await tx<{ id: string }[]>`
      INSERT INTO app.notification_dispatch_logs (
        school_id, event_id, event_type, recipient_id, recipient_role, channel,
        idempotency_key, status, rendered_title, rendered_body
      ) VALUES (
        ${schoolId}::uuid, ${`evt-${tag}`}, 'grades.published', ${userId}::uuid, 'parent',
        'push', ${`grades.published:${tag}:${userId}:push`}, 'enqueued', 'Maths grade posted',
        'Amina scored 18/20'
      )
      RETURNING id
    `;

    return { schoolId, userId, dispatchLogId: log!.id, devices };
  });
}

async function dispatchStatus(fixture: Fixture): Promise<string> {
  const [row] = await sql<{ status: string }[]>`
    SELECT status::text AS status
    FROM app.notification_dispatch_logs
    WHERE school_id = ${fixture.schoolId}::uuid AND id = ${fixture.dispatchLogId}::uuid
  `;
  return row!.status;
}

async function revokedTokens(fixture: Fixture): Promise<string[]> {
  const rows = await sql<{ fcm_token: string }[]>`
    SELECT fcm_token
    FROM app.user_devices
    WHERE school_id = ${fixture.schoolId}::uuid AND user_id = ${fixture.userId}::uuid
      AND revoked_at IS NOT NULL
  `;
  return rows.map((row) => row.fcm_token);
}

async function liveTokens(fixture: Fixture): Promise<string[]> {
  const rows = await sql<{ fcm_token: string }[]>`
    SELECT fcm_token
    FROM app.user_devices
    WHERE school_id = ${fixture.schoolId}::uuid AND user_id = ${fixture.userId}::uuid
      AND revoked_at IS NULL
  `;
  return rows.map((row) => row.fcm_token);
}

interface StubSender extends PushSender {
  sends: { message: PushMessage; devices: PushDevice[] }[];
}

/** A sender that answers `result` every time and records what it was asked to send. */
function stubSender(result: PushSendResult): StubSender {
  const sends: { message: PushMessage; devices: PushDevice[] }[] = [];
  return {
    sends,
    async send(message, devices) {
      sends.push({ message, devices });
      return result;
    },
  };
}

function jobData(fixture: Fixture): Parameters<typeof processNotificationDelivery>[0] {
  return {
    schoolId: fixture.schoolId,
    dispatchLogId: fixture.dispatchLogId,
    recipientId: fixture.userId,
    channel: "push",
    notificationType: "GRADE_POSTED",
    title: "Maths grade posted",
    body: "Amina scored 18/20",
    route: "/courses/c-1/grades",
  };
}

function deps(sender: PushSender) {
  return { databaseUrl: databaseUrl!, log: quietLogger(), push: sender };
}

function quietLogger() {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

describeDb("processNotificationDelivery — push channel", () => {
  test("delivers and advances the dispatch log once FCM accepts a message", async () => {
    const fixture = await seedPushFixture(["token-live"]);
    const sender = stubSender({ unregisteredDeviceIds: [], sent: 1, dryRun: true });

    const result = await processNotificationDelivery(jobData(fixture), deps(sender));

    expect(result).toEqual({
      processed: true,
      channel: "push",
      routesResolved: 1,
      sent: true,
      pruned: 0,
    });
    expect(await dispatchStatus(fixture)).toBe("delivered");
    expect(snapshot().sent).toBe(1);
  });

  test("the deep-link route travels in the payload", async () => {
    const fixture = await seedPushFixture(["token-live"]);
    const sender = stubSender({ unregisteredDeviceIds: [], sent: 1, dryRun: true });

    await processNotificationDelivery(jobData(fixture), deps(sender));

    expect(sender.sends).toHaveLength(1);
    expect(sender.sends[0]!.message.route).toBe("/courses/c-1/grades");
  });

  test("revokes unregistered tokens and still delivers to the live ones", async () => {
    const fixture = await seedPushFixture(["token-dead", "token-live"]);
    const sender = stubSender({
      unregisteredDeviceIds: [fixture.devices[0]!.id],
      sent: 1,
      dryRun: true,
    });

    const result = await processNotificationDelivery(jobData(fixture), deps(sender));

    expect(result.sent).toBe(true);
    expect(result.pruned).toBe(1);
    expect(await revokedTokens(fixture)).toEqual(["token-dead"]);
    expect(await liveTokens(fixture)).toEqual(["token-live"]);
    expect(await dispatchStatus(fixture)).toBe("delivered");
    expect(snapshot().pruned).toBe(1);
  });

  test("every token dead means nothing delivered, and the log stays honest at enqueued", async () => {
    const fixture = await seedPushFixture(["token-dead-a", "token-dead-b"]);
    const sender = stubSender({
      unregisteredDeviceIds: [fixture.devices[0]!.id, fixture.devices[1]!.id],
      sent: 0,
      dryRun: true,
    });

    const result = await processNotificationDelivery(jobData(fixture), deps(sender));

    expect(result.sent).toBe(false);
    expect(result.pruned).toBe(2);
    expect(await revokedTokens(fixture)).toHaveLength(2);
    // Zero accepted messages must not be recorded as delivered.
    expect(await dispatchStatus(fixture)).toBe("enqueued");
  });

  test("caps the fan-out at the most recently seen devices", async () => {
    const tokens = Array.from({ length: MAX_DEVICES_PER_USER + 2 }, (_, index) => `token-${index}`);
    const fixture = await seedPushFixture(tokens);
    const sender = stubSender({
      unregisteredDeviceIds: [],
      sent: MAX_DEVICES_PER_USER,
      dryRun: true,
    });

    const result = await processNotificationDelivery(jobData(fixture), deps(sender));

    // Only the five most recently seen devices are targeted — the newest is tokens[0].
    const sentTokens = sender.sends[0]!.devices.map((device) => device.token);
    expect(sentTokens).toEqual(tokens.slice(0, MAX_DEVICES_PER_USER));
    // The overflow is real hardware, not garbage: it is measured, not revoked.
    expect(await liveTokens(fixture)).toHaveLength(tokens.length);
    expect(result.routesResolved).toBe(tokens.length);
    expect(snapshot().devicesSkippedCap).toBe(2);
    expect(await dispatchStatus(fixture)).toBe("delivered");
  });

  test("a recipient with no live device is not delivered and the gap is visible", async () => {
    const fixture = await seedPushFixture([]);
    const sender = stubSender({ unregisteredDeviceIds: [], sent: 0, dryRun: true });

    const result = await processNotificationDelivery(jobData(fixture), deps(sender));

    expect(result.sent).toBe(false);
    expect(result.routesResolved).toBe(0);
    expect(await dispatchStatus(fixture)).toBe("enqueued");
    expect(snapshot().noTokens).toBe(1);
    expect(sender.sends).toHaveLength(0);
  });

  test("a failed send throws, retries, and never claims delivered", async () => {
    const fixture = await seedPushFixture(["token-live"]);
    const failing: PushSender = {
      async send() {
        throw new Error("FCM auth failure");
      },
    };

    await expect(processNotificationDelivery(jobData(fixture), deps(failing))).rejects.toThrow(
      "FCM auth failure",
    );
    expect(await dispatchStatus(fixture)).toBe("enqueued");
  });
});
