import { createHmac } from "node:crypto";

import { DOMAIN_EVENTS } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createApp } from "../../src/app";
import { createInflightTracker } from "../../src/lifecycle";
import { createLogger } from "../../src/logger";
import {
  createAcademicYear,
  createSchool,
  createStudent,
  createTerm,
  createTestDatabase,
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import type { AppEnv } from "../../src/middleware";
import type { TestDatabase } from "../harness";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Sql } from "postgres";

/**
 * Database-backed ERPNext webhook tests.
 *
 * The pre-DB suite (src/erpnext/webhook.test.ts) covers everything that returns before the handler
 * touches Postgres. This suite exercises the happy path's three writes inside one tenant
 * transaction — the dedup row, the audit_logs row, and the app.outbox_events insert — and guards
 * the outbox payload's encoding: it must land as a jsonb object, never a JSON-encoded string
 * (binding a pre-stringified string with a ::jsonb cast makes postgres.js JSON-encode it a second
 * time; outbox_events.payload has no jsonb_typeof CHECK, so that mistake would store silently and
 * corrupt every relay consumer downstream). It also proves ERPNext's at-least-once redelivery is
 * absorbed by the (school_id, event_id) unique constraint, and that events route to their own
 * school's outbox. Gated on TEST_DATABASE_URL; runs in the `api-integration` job.
 *
 * The payloads in the outbox-focused describes below deliberately omit `data.name`, so the cache
 * projections return early and this suite stays focused on ingestion. The projection describes at
 * the bottom carry `data.name` and prove the cache arms actually work: the invoice and fee-schedule
 * projections previously passed codes into uuid foreign keys and raw decimals into `_minor` bigint
 * columns (same bug class the payment arm had before ST-121), so every real payload 500'd. They now
 * resolve the student, look the currency up in app.currencies, and convert through the currency's
 * own exponent (3 for JOD, not 2).
 */

const SECRET = "test-webhook-secret";

const integrationTest = test.skipIf(!integrationEnabled);

let database: TestDatabase | undefined;
let sql: Sql;
let app: OpenAPIHono<AppEnv>;
let schoolA: { id: string; slug: string };
let schoolB: { id: string; slug: string };

let previousSecret: string | undefined;

const sign = (body: string): string => createHmac("sha256", SECRET).update(body).digest("hex");

const post = (body: object) => {
  const raw = JSON.stringify(body);
  return app.request("/erpnext/webhooks", {
    method: "POST",
    headers: { "content-type": "application/json", "x-erpnext-signature": sign(raw) },
    body: raw,
  });
};

/** One ERPNext document event, keyed on the (event_id, school_id) pair the route deduplicates on. */
const event = (
  eventId: string,
  data: Record<string, unknown>,
  doctype = "Sales Invoice",
  action = "submitted",
) => ({
  event_id: eventId,
  doctype,
  action,
  data,
});

async function outboxCount(): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM app.outbox_events
    WHERE event_name = ${DOMAIN_EVENTS.ERPNEXT_INVOICE_SUBMITTED}
  `;
  return row?.count ?? 0;
}

async function dedupCount(schoolId: string): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM app.erpnext_webhook_dedup WHERE school_id = ${schoolId}
  `;
  return row?.count ?? 0;
}

async function auditCount(schoolId: string): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM app.audit_logs
    WHERE school_id = ${schoolId} AND target_table = 'erpnext_webhook_dedup'
  `;
  return row?.count ?? 0;
}

/** The seeded JOD reference (minor_unit = 3), the currency the projections default to. */
async function jodCurrencyId(): Promise<string> {
  const [row] = await sql<{ id: string }[]>`SELECT id FROM app.currencies WHERE code = 'JOD'`;
  expect(row).toBeDefined();
  return row!.id;
}

beforeAll(async () => {
  if (!integrationEnabled) return;

  database = await createTestDatabase();
  await migrateDatabase(database.url);
  sql = database.sql;

  schoolA = await createSchool(sql);
  schoolB = await createSchool(sql);

  previousSecret = process.env.ERPNEXT_WEBHOOK_SECRET;
  process.env.ERPNEXT_WEBHOOK_SECRET = SECRET;

  app = createApp({
    isReady: () => true,
    tracker: createInflightTracker(),
    logger: createLogger({ destination: () => undefined }),
    redis: null,
    database: sql,
  });
}, 60_000);

afterAll(async () => {
  if (previousSecret === undefined) {
    delete process.env.ERPNEXT_WEBHOOK_SECRET;
  } else {
    process.env.ERPNEXT_WEBHOOK_SECRET = previousSecret;
  }
  await database?.cleanup();
});

describe("outbox payload encoding", () => {
  integrationTest(
    "stores the outbox payload as a jsonb object, writes the dedup row, and audits the insert",
    async () => {
      const eventId = "evt-outbox-1";
      const data = { school_id: schoolA.id, note: "custom-field", amount: 42.5 };

      const res = await post(event(eventId, data));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });

      const [outbox] = await sql<{ school_id: string; event_name: string; payload: object }[]>`
        SELECT school_id, event_name, payload FROM app.outbox_events
        WHERE event_name = ${DOMAIN_EVENTS.ERPNEXT_INVOICE_SUBMITTED}
        ORDER BY id DESC
        LIMIT 1
      `;
      expect(outbox?.school_id).toBe(schoolA.id);
      expect(outbox?.event_name).toBe(DOMAIN_EVENTS.ERPNEXT_INVOICE_SUBMITTED);
      expect(outbox?.payload).toEqual(data);

      // The regression guard: a jsonb string scalar here means the payload was double-encoded, and
      // every consumer of this row (the outbox relay, the email dispatcher reading payload.email)
      // would silently misbehave.
      const [payloadType] = await sql<{ payload_type: string }[]>`
        SELECT jsonb_typeof(payload)::text AS payload_type FROM app.outbox_events
        WHERE event_name = ${DOMAIN_EVENTS.ERPNEXT_INVOICE_SUBMITTED}
        ORDER BY id DESC
        LIMIT 1
      `;
      expect(payloadType?.payload_type).toBe("object");

      const [dedup] = await sql<{ id: string }[]>`
        SELECT id FROM app.erpnext_webhook_dedup WHERE school_id = ${schoolA.id} AND event_id = ${eventId}
      `;
      expect(dedup).toBeDefined();

      // The dedup row's id is a uuid (000075), so the audit reference cast succeeds. Before that
      // migration this transaction 500'd on every mapped event.
      const [audit] = await sql<{ target_table: string; target_id: string; action: string }[]>`
        SELECT target_table, target_id, action FROM app.audit_logs
        WHERE school_id = ${schoolA.id} AND target_table = 'erpnext_webhook_dedup'
      `;
      expect(audit?.target_table).toBe("erpnext_webhook_dedup");
      expect(audit?.target_id).toBe(dedup?.id);
      expect(audit?.action).toBe("insert");
    },
  );
});

describe("deduplication", () => {
  integrationTest("absorbs an ERPNext redelivery without re-enqueuing or re-auditing", async () => {
    const eventId = "evt-dedup-1";
    const body = event(eventId, { school_id: schoolA.id });

    const outboxBefore = await outboxCount();
    const dedupBefore = await dedupCount(schoolA.id);
    const auditBefore = await auditCount(schoolA.id);

    const first = await post(body);
    const redelivery = await post(body);

    expect(first.status).toBe(200);
    expect(redelivery.status).toBe(200);

    expect(await outboxCount()).toBe(outboxBefore + 1);
    expect(await dedupCount(schoolA.id)).toBe(dedupBefore + 1);
    expect(await auditCount(schoolA.id)).toBe(auditBefore + 1);
  });
});

describe("tenant routing", () => {
  integrationTest("lands each school's event in its own outbox", async () => {
    const eventA = event("evt-tenant-a", { school_id: schoolA.id });
    const eventB = event("evt-tenant-b", { school_id: schoolB.id });

    const before = await outboxCount();

    const [resA, resB] = await Promise.all([post(eventA), post(eventB)]);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    const rows = [
      ...(await sql<{ school_id: string; payload: { school_id: string } }[]>`
        SELECT school_id, payload FROM app.outbox_events
        WHERE event_name = ${DOMAIN_EVENTS.ERPNEXT_INVOICE_SUBMITTED}
        ORDER BY id DESC
        LIMIT ${before + 2}
      `),
    ];
    const newRows = rows.slice(0, 2);
    expect(newRows).toHaveLength(2);
    for (const row of newRows) expect(row.school_id).toBe(row.payload.school_id);
    expect(newRows.map((row) => row.school_id).sort()).toEqual([schoolA.id, schoolB.id].sort());
  });
});

describe("invoice cache projection", () => {
  integrationTest(
    "resolves the student and currency and converts amounts with the currency's own exponent",
    async () => {
      const student = await createStudent(sql, schoolA.id, { admissionNumber: "ADM-2026-0042" });
      const jodId = await jodCurrencyId();
      const data = {
        school_id: schoolA.id,
        name: "SINV-2026-0001",
        // The ERPNext Customer this gateway creates for a student is the admission number, so the
        // projection resolves student_id through normalized_admission_number. Mixed case proves the
        // lookup is case-insensitive.
        customer: "adm-2026-0042",
        currency: "JOD",
        grand_total: 100.45,
        outstanding_amount: 50.45,
        posting_date: "2026-07-01",
        due_date: "2026-08-01",
      };

      const res = await post(event("evt-invoice-1", data));
      expect(res.status).toBe(200);

      const [cached] = await sql<
        {
          id: string;
          student_id: string;
          currency_id: string;
          erpnext_docname: string;
          erpnext_status: string;
          total_amount_minor: string;
          outstanding_amount_minor: string;
          due_date: string | null;
          payload: object;
        }[]
      >`
        SELECT id, student_id, currency_id, erpnext_docname, erpnext_status,
               total_amount_minor, outstanding_amount_minor, due_date::text AS due_date,
               erpnext_payload AS payload
        FROM app.invoice_cache
        WHERE school_id = ${schoolA.id} AND erpnext_docname = 'SINV-2026-0001'
      `;
      expect(cached).toBeDefined();
      expect(cached?.student_id).toBe(student.id);
      expect(cached?.currency_id).toBe(jodId);
      expect(cached?.erpnext_docname).toBe("SINV-2026-0001");
      expect(cached?.erpnext_status).toBe("submitted");
      // JOD has minor_unit 3: 100.45 JOD is 100450 fils. A *100 implementation would have stored
      // 10045 and silently divided by ten. (int8 arrives as a string: postgres.js returns it that
      // way by default, since it can exceed Number.MAX_SAFE_INTEGER.)
      expect(cached?.total_amount_minor).toBe("100450");
      expect(cached?.outstanding_amount_minor).toBe("50450");
      expect(cached?.due_date).toBe("2026-08-01");
      expect(cached?.payload).toEqual(data);

      const [mapping] = await sql<{ entity: string; studafy_id: string }[]>`
        SELECT entity::text AS entity, studafy_id
        FROM app.erpnext_id_mappings
        WHERE school_id = ${schoolA.id} AND erpnext_docname = 'SINV-2026-0001'
      `;
      expect(mapping?.entity).toBe("invoice");
      expect(mapping?.studafy_id).toBe(cached!.id);

      // Redelivering the same event is absorbed by the dedup row, so the cache row is not re-created
      // and its id (the mapping's studafy_id) is not churned.
      const redelivery = await post(event("evt-invoice-1", data));
      expect(redelivery.status).toBe(200);

      const [count] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count
        FROM app.invoice_cache WHERE school_id = ${schoolA.id} AND erpnext_docname = 'SINV-2026-0001'
      `;
      expect(count?.count).toBe(1);
    },
  );

  integrationTest(
    "answers 200 and leaves no cache row when the student cannot be resolved",
    async () => {
      const data = {
        school_id: schoolA.id,
        name: "SINV-2026-9999",
        customer: "NO-SUCH-STUDENT",
        currency: "JOD",
        grand_total: 25,
      };

      const res = await post(event("evt-invoice-2", data));
      expect(res.status).toBe(200);

      const [cached] = await sql`
      SELECT id FROM app.invoice_cache
      WHERE school_id = ${schoolA.id} AND erpnext_docname = 'SINV-2026-9999'
    `;
      expect(cached).toBeUndefined();
    },
  );

  integrationTest("answers 200 and leaves no cache row for an unknown currency", async () => {
    const data = {
      school_id: schoolA.id,
      name: "SINV-2026-0002",
      customer: "NO-SUCH-STUDENT",
      currency: "XXX",
      grand_total: 25,
    };

    const res = await post(event("evt-invoice-3", data));
    expect(res.status).toBe(200);

    const [cached] = await sql`
      SELECT id FROM app.invoice_cache
      WHERE school_id = ${schoolA.id} AND erpnext_docname = 'SINV-2026-0002'
    `;
    expect(cached).toBeUndefined();
  });
});

describe("fee schedule cache projection", () => {
  integrationTest(
    "resolves the year and term by code and converts the total to minor units",
    async () => {
      const year = await createAcademicYear(sql, schoolA.id, { code: "AY-2026-2027" });
      const term = await createTerm(sql, schoolA.id, year.id, { code: "T1-2026" });
      const jodId = await jodCurrencyId();
      const data = {
        school_id: schoolA.id,
        name: "FS-2026-0001",
        currency: "JOD",
        total_amount: 300.45,
        fee_name: "Annual Tuition 2026",
        academic_year: "AY-2026-2027",
        term: "T1-2026",
      };

      const res = await post(event("evt-fee-1", data, "Fee Schedule", "submitted"));
      expect(res.status).toBe(200);

      const [cached] = await sql<
        {
          id: string;
          academic_year_id: string | null;
          term_id: string | null;
          currency_id: string;
          erpnext_docname: string;
          erpnext_status: string;
          title: string;
          total_amount_minor: string;
          payload: object;
        }[]
      >`
        SELECT id, academic_year_id, term_id, currency_id, erpnext_docname,
               erpnext_status, title, total_amount_minor, erpnext_payload AS payload
        FROM app.fee_schedule_cache
        WHERE school_id = ${schoolA.id} AND erpnext_docname = 'FS-2026-0001'
      `;
      expect(cached).toBeDefined();
      expect(cached?.academic_year_id).toBe(year.id);
      expect(cached?.term_id).toBe(term.id);
      expect(cached?.currency_id).toBe(jodId);
      expect(cached?.erpnext_docname).toBe("FS-2026-0001");
      expect(cached?.erpnext_status).toBe("submitted");
      expect(cached?.title).toBe("Annual Tuition 2026");
      expect(cached?.total_amount_minor).toBe("300450");
      expect(cached?.payload).toEqual(data);

      const [mapping] = await sql<{ entity: string; studafy_id: string }[]>`
        SELECT entity::text AS entity, studafy_id
        FROM app.erpnext_id_mappings
        WHERE school_id = ${schoolA.id} AND erpnext_docname = 'FS-2026-0001'
      `;
      expect(mapping?.entity).toBe("fee_schedule");
      expect(mapping?.studafy_id).toBe(cached!.id);
    },
  );
});

describe("unmapped events", () => {
  integrationTest("answers 200 for an unknown doctype without touching the database", async () => {
    const before = await outboxCount();
    const body = event("evt-unknown-1", {}, "Unknown DocType");

    const res = await post(body);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await outboxCount()).toBe(before);

    const [unknownDedup] = await sql`
      SELECT id FROM app.erpnext_webhook_dedup WHERE event_id = 'evt-unknown-1'
    `;
    expect(unknownDedup).toBeUndefined();
  });
});
