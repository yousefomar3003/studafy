/**
 * Pending-school discovery for the outbox consumers (000199/000200), and the indexes it rests on.
 *
 * Needs a migrated TEST_DATABASE_URL, like the other DB-backed worker suites. The database is shared
 * with them, so every assertion is about the schools a test seeded itself — other suites' leftover
 * rows may make other schools pending, which is fine.
 */

import { DOMAIN_EVENTS } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { ENTITLEMENT_EVENT_NAMES, USER_ENTITLEMENT_EVENT_NAME } from "./entitlements/claim";
import { EMAIL_EVENT_NAMES } from "./notifications/email/resolve";
import { discoverPendingSchools } from "./outbox-discovery";

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

async function seedSchool(): Promise<string> {
  return db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    const [reference] = await tx<{ country: string; currency: string }[]>`
      SELECT
        (SELECT id FROM app.countries WHERE alpha2_code = 'US') AS country,
        (SELECT id FROM app.currencies WHERE code = 'USD') AS currency
    `;
    const slug = `disc-${crypto.randomUUID().slice(0, 8)}`;
    const [school] = await tx<{ id: string }[]>`
      INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
      VALUES (
        ${slug}, ${`Discovery ${slug}`}, ${`${slug}@admin.local`}, ${`${slug}@admin.local`},
        ${reference!.country}, ${reference!.currency}
      )
      RETURNING id
    `;
    return school!.id;
  });
}

/**
 * One outbox row with every consumer's cursor already set, so it is pending for nobody; `pending`
 * clears the cursors named, and `columns` sets anything else.
 */
async function seedRow(
  schoolId: string,
  eventName: string,
  pending: ("relay" | "email" | "entitlement")[],
  columns: { emailNextAttemptAt?: string } = {},
): Promise<string> {
  const rows = await db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    const done = new Date(Date.now() + 1_000).toISOString();
    return tx<{ id: string }[]>`
      INSERT INTO app.outbox_events
        (school_id, event_name, payload, relayed_at, email_dispatched_at, entitlement_applied_at,
         email_next_attempt_at)
      VALUES (
        ${schoolId}::uuid, ${eventName}, ${tx.json({})},
        ${pending.includes("relay") ? null : done},
        ${pending.includes("email") ? null : done},
        ${pending.includes("entitlement") ? null : done},
        ${columns.emailNextAttemptAt ?? null}
      )
      RETURNING id::text AS id
    `;
  });
  return rows[0]!.id;
}

describe("app.outbox_pending_school_ids", () => {
  dbTest("relay: names a school with an unrelayed row and not one without", async () => {
    const busy = await seedSchool();
    const idle = await seedSchool();
    await seedRow(busy, DOMAIN_EVENTS.SUBSCRIPTION_STATUS_CHANGED, ["relay"]);
    await seedRow(idle, DOMAIN_EVENTS.SUBSCRIPTION_STATUS_CHANGED, []);

    const pending = await discoverPendingSchools(db!, "relay");
    expect(pending).toContain(busy);
    expect(pending).not.toContain(idle);
  });

  dbTest("entitlement: both partial indexes count, other events do not", async () => {
    const school = await seedSchool();
    const user = await seedSchool();
    const other = await seedSchool();
    await seedRow(school, ENTITLEMENT_EVENT_NAMES[0], ["entitlement"]);
    await seedRow(user, USER_ENTITLEMENT_EVENT_NAME, ["entitlement"]);
    // A cleared entitlement cursor on an event the invalidator never claims is not pending work.
    await seedRow(other, DOMAIN_EVENTS.INVITATION_SENT, ["entitlement"]);

    const pending = await discoverPendingSchools(db!, "entitlement");
    expect(pending).toContain(school);
    expect(pending).toContain(user);
    expect(pending).not.toContain(other);
  });

  dbTest("email: only email events, and not while a retry is scheduled", async () => {
    const ready = await seedSchool();
    const nonEmail = await seedSchool();
    const backedOff = await seedSchool();
    const due = await seedSchool();
    await seedRow(ready, DOMAIN_EVENTS.INVITATION_SENT, ["email"]);
    // Every non-email event keeps email_dispatched_at NULL forever; that is not email work.
    await seedRow(nonEmail, DOMAIN_EVENTS.SUBSCRIPTION_STATUS_CHANGED, ["email"]);
    await seedRow(backedOff, DOMAIN_EVENTS.INVITATION_SENT, ["email"], {
      emailNextAttemptAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    await seedRow(due, DOMAIN_EVENTS.INVITATION_SENT, ["email"], {
      emailNextAttemptAt: new Date(Date.now() - 1_000).toISOString(),
    });

    const pending = await discoverPendingSchools(db!, "email");
    expect(pending).toContain(ready);
    expect(pending).toContain(due);
    expect(pending).not.toContain(nonEmail);
    expect(pending).not.toContain(backedOff);
  });

  dbTest("leaves the caller's app.school_id as it found it", async () => {
    const school = await seedSchool();
    await seedRow(school, DOMAIN_EVENTS.INVITATION_SENT, ["relay"]);
    const marker = "11111111-1111-1111-1111-111111111111";

    const [row] = await db!.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE studafy_admin");
      await tx`SELECT set_config('app.school_id', ${marker}, true)`;
      await tx`SELECT count(*) FROM app.outbox_pending_school_ids('relay')`;
      return tx<{ school: string }[]>`SELECT current_setting('app.school_id') AS school`;
    });
    expect(row!.school).toBe(marker);
  });

  dbTest("rejects an unknown consumer", async () => {
    await expect(
      db!.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE studafy_admin");
        await tx`SELECT count(*) FROM app.outbox_pending_school_ids('nope')`;
      }),
    ).rejects.toThrow("unknown outbox consumer");
  });

  dbTest("is studafy_admin-only, invoker-rights, with a pinned search_path", async () => {
    const [fn] = await db!<
      {
        owner: string;
        security_definer: boolean;
        configuration: string[];
        public_execute: boolean;
        app_execute: boolean;
        admin_execute: boolean;
      }[]
    >`
      SELECT pg_get_userbyid(p.proowner) AS owner,
             p.prosecdef AS security_definer,
             p.proconfig AS configuration,
             has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute,
             has_function_privilege('studafy_app', p.oid, 'EXECUTE') AS app_execute,
             has_function_privilege('studafy_admin', p.oid, 'EXECUTE') AS admin_execute
      FROM pg_proc p
      WHERE p.oid = 'app.outbox_pending_school_ids(text)'::regprocedure
    `;
    expect(fn).toEqual({
      owner: "studafy_admin",
      security_definer: false,
      configuration: ["search_path=pg_catalog"],
      public_execute: false,
      app_execute: false,
      admin_execute: true,
    });
  });
});

describe("email claim index (000199)", () => {
  dbTest("names exactly EMAIL_EVENT_NAMES and replaces the 000077 index", async () => {
    const indexes = await db!<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'app' AND tablename = 'outbox_events'
        AND indexname IN ('idx_outbox_events_school_email_claim',
                          'idx_outbox_events_school_email_pending')
    `;
    expect(indexes.map((index) => index.indexname)).toEqual([
      "idx_outbox_events_school_email_claim",
    ]);
    const definition = indexes[0]!.indexdef;
    expect(definition).toContain("(school_id, id)");
    expect(definition).toContain("email_dispatched_at IS NULL");

    // Every name the dispatcher claims is in the predicate, and nothing else is: a name missing
    // here would stop the planner proving the claim implies the predicate (a sequential scan of the
    // outbox), and an extra one would index rows no consumer claims.
    const named = [...definition.matchAll(/'([^']+)'::text/g)].map((match) => match[1]);
    expect([...named].sort()).toEqual([...EMAIL_EVENT_NAMES].sort());
  });

  dbTest("the dispatcher's claim and the discovery probe can use it", async () => {
    const school = await seedSchool();
    const plans = await db!.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE studafy_admin");
      await tx`SELECT set_config('app.school_id', ${school}, true)`;
      // A near-empty table would otherwise be seq-scanned; this asks whether the index is usable.
      await tx`SET LOCAL enable_seqscan = off`;
      const claim = await tx.unsafe<{ "QUERY PLAN": string }[]>(
        `EXPLAIN SELECT id FROM app.outbox_events
         WHERE event_name IN ('invitation.sent', 'digest.sent')
           AND email_dispatched_at IS NULL
           AND (email_next_attempt_at IS NULL OR email_next_attempt_at <= CURRENT_TIMESTAMP)
         ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1`,
      );
      return claim.map((row) => row["QUERY PLAN"]).join("\n");
    });
    expect(plans).toContain("idx_outbox_events_school_email_claim");
  });
});
