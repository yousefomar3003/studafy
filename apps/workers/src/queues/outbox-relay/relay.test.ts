/**
 * The outbox relay's discovery-driven cycle. Needs a migrated TEST_DATABASE_URL; Redis is a stub
 * that records what would have been published.
 */

import { DOMAIN_EVENTS } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { pollOnce } from "./relay";

import type { RelayContext } from "./relay";
import type IORedis from "ioredis";
import type { Sql } from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
const dbTest = test.skipIf(!databaseUrl);

let db: Sql | undefined;

beforeAll(() => {
  if (!databaseUrl) return;
  db = postgres(databaseUrl, { max: 4, ssl: false, prepare: false });
});

afterAll(async () => {
  await db?.end({ timeout: 5 });
});

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

function context(schoolIds: string[] | null) {
  const published: string[] = [];
  const redis = {
    publish: async (channel: string) => {
      published.push(channel);
      return 1;
    },
  } as unknown as IORedis;
  const ctx: RelayContext = {
    db: db!,
    redis,
    config: { batchSize: 100, pollIntervalMs: 500, schoolIds },
    logger: silentLogger,
  };
  return { ctx, published };
}

async function seedSchool(): Promise<string> {
  return db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    const [reference] = await tx<{ country: string; currency: string }[]>`
      SELECT
        (SELECT id FROM app.countries WHERE alpha2_code = 'US') AS country,
        (SELECT id FROM app.currencies WHERE code = 'USD') AS currency
    `;
    const slug = `relay-${crypto.randomUUID().slice(0, 8)}`;
    const [school] = await tx<{ id: string }[]>`
      INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
      VALUES (
        ${slug}, ${`Relay ${slug}`}, ${`${slug}@admin.local`}, ${`${slug}@admin.local`},
        ${reference!.country}, ${reference!.currency}
      )
      RETURNING id
    `;
    return school!.id;
  });
}

async function seedUnrelayed(schoolId: string): Promise<string> {
  const rows = await db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    return tx<{ id: string }[]>`
      INSERT INTO app.outbox_events (school_id, event_name, payload)
      VALUES (${schoolId}::uuid, ${DOMAIN_EVENTS.SUBSCRIPTION_STATUS_CHANGED}, ${tx.json({ schoolId })})
      RETURNING id::text AS id
    `;
  });
  return rows[0]!.id;
}

async function isRelayed(schoolId: string, id: string): Promise<boolean> {
  const [row] = await db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    return tx<{ relayed: boolean }[]>`
      SELECT relayed_at IS NOT NULL AS relayed FROM app.outbox_events WHERE id = ${id}::bigint
    `;
  });
  return row!.relayed;
}

describe("outbox relay cycle", () => {
  dbTest("relays a pending school's rows under its tenant, then finds it idle", async () => {
    const school = await seedSchool();
    const id = await seedUnrelayed(school);
    const channel = `events:${school}:${DOMAIN_EVENTS.SUBSCRIPTION_STATUS_CHANGED}`;

    const first = context([school]);
    expect(await pollOnce(first.ctx)).toBe(1);
    expect(first.published).toEqual([channel]);
    expect(await isRelayed(school, id)).toBe(true);

    const second = context([school]);
    expect(await pollOnce(second.ctx)).toBe(0);
    expect(second.published).toEqual([]);
  });

  dbTest("an explicit school list narrows what discovery found", async () => {
    const included = await seedSchool();
    const excluded = await seedSchool();
    const includedRow = await seedUnrelayed(included);
    const excludedRow = await seedUnrelayed(excluded);

    const { ctx } = context([included]);
    expect(await pollOnce(ctx)).toBe(1);
    expect(await isRelayed(included, includedRow)).toBe(true);
    expect(await isRelayed(excluded, excludedRow)).toBe(false);

    // Without an override every discovered school is relayed.
    const all = context(null);
    expect(await pollOnce(all.ctx)).toBeGreaterThanOrEqual(1);
    expect(await isRelayed(excluded, excludedRow)).toBe(true);
  });
});
