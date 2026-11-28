/**
 * The ERPNext site agent's API (docs/plans/erpnext-fly.md, "Agent API") end to end, against a real
 * migrated database with RLS armed: the bearer token, the unmounted 404, every list's filtering
 * rules (the 10-minute failed retry, the limit of 5, the 30-day idle rule), every report's update
 * and audit row, and 404 for an unknown id.
 *
 *   TEST_DATABASE_URL=postgres://... bun test src/modules/finance/erpnext-agent
 */

import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  createFullTenant,
  createSchool,
  createTestApp,
  createTestDatabase,
  integrationEnabled,
  migrateDatabase,
  mintTestToken,
} from "../../../../../tests/harness";
import { resolveRouteClass, ROUTE_CLASS_MAP } from "../../../../config/rateLimits";

import type { TestApp, TestDatabase } from "../../../../../tests/harness";

const describeDb = integrationEnabled ? describe : describe.skip;

const TOKEN = "agent-token-for-tests-0123456789abcdef";
const BASE = "/api/internal/erpnext";

let db: TestDatabase;
let harness: TestApp | undefined;
let unmounted: TestApp | undefined;

interface SiteFixture {
  schoolId: string;
  id: string;
  siteName: string;
}

interface SiteState {
  status?: "pending" | "in_progress" | "completed" | "failed";
  siteCreatedAt?: string | null;
  schedulerEnabled?: boolean;
  wakeRequestedAt?: string | null;
  lastFinanceActivityAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  country?: string;
  currency?: string;
}

/** A school with one site config row. Times are SQL interval offsets from now, e.g. '-2 hours'. */
async function site(state: SiteState = {}): Promise<SiteFixture> {
  const school = await createSchool(db.sql);
  if (state.country || state.currency) {
    await db.sql`
      UPDATE app.schools
      SET country_id = (SELECT id FROM app.countries WHERE alpha2_code = ${state.country ?? "US"}),
          default_currency_id = (SELECT id FROM app.currencies WHERE code = ${state.currency ?? "USD"})
      WHERE id = ${school.id}::uuid
    `;
  }
  const at = (offset: string | null | undefined) =>
    offset === null || offset === undefined ? null : offset;
  const siteName = `${school.slug}.erpnext.test`;
  const [row] = await db.sql<{ id: string }[]>`
    INSERT INTO app.erpnext_site_configs (
      school_id, site_name, company_name, company_abbr, status, site_created_at, scheduler_enabled,
      wake_requested_at, last_finance_activity_at, created_at, updated_at
    ) VALUES (
      ${school.id}::uuid, ${siteName}, ${`Company ${school.slug}`}, 'TEST',
      ${state.status ?? "pending"}::app.provisioning_status,
      now() + ${at(state.siteCreatedAt)}::interval,
      ${state.schedulerEnabled ?? false},
      now() + ${at(state.wakeRequestedAt)}::interval,
      now() + ${at(state.lastFinanceActivityAt)}::interval,
      now() + ${state.createdAt ?? "0 seconds"}::interval,
      now() + ${state.updatedAt ?? state.createdAt ?? "0 seconds"}::interval
    )
    RETURNING id
  `;
  return { schoolId: school.id, id: row!.id, siteName };
}

async function row(id: string) {
  const [found] = await db.sql<
    {
      status: string;
      last_error: string | null;
      site_created_at: Date | null;
      scheduler_enabled: boolean;
      wake_requested_at: Date | null;
    }[]
  >`
    SELECT status::text AS status, last_error, site_created_at, scheduler_enabled, wake_requested_at
    FROM app.erpnext_site_configs WHERE id = ${id}::uuid
  `;
  return found!;
}

function call(
  method: "GET" | "POST",
  path: string,
  init: { token?: string | null; body?: unknown } = {},
) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = init.token === undefined ? TOKEN : init.token;
  if (typeof token === "string") headers.authorization = `Bearer ${token}`;
  return harness!.app.request(`${BASE}${path}`, {
    method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function sites(path: string): Promise<{ id: string; site_name: string }[]> {
  const res = await call("GET", path);
  expect(res.status).toBe(200);
  return ((await res.json()) as { sites: { id: string; site_name: string }[] }).sites;
}

// Fixtures for the pending list's filters. Every other fixture is 'completed', so it never appears.
const pending = {} as Record<
  "waiting" | "failedLongAgo" | "failedRecently" | "created" | "done",
  SiteFixture
>;
// Fixtures for the wake and idle lists.
const sleep = {} as Record<
  "asleepAsked" | "awakeAsked" | "notCreatedAsked" | "asleepNotAsked",
  SiteFixture
>;
const idle = {} as Record<
  "oldActivity" | "neverUsedOld" | "recentActivity" | "asleepOld",
  SiteFixture
>;

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createTestDatabase();
  await migrateDatabase(db.url);

  pending.waiting = await site({ createdAt: "-6 hours", country: "JO", currency: "JOD" });
  pending.failedLongAgo = await site({
    status: "failed",
    createdAt: "-5 hours",
    updatedAt: "-11 minutes",
    country: "SA",
    currency: "SAR",
  });
  pending.failedRecently = await site({
    status: "failed",
    createdAt: "-4 hours",
    updatedAt: "-9 minutes",
  });
  pending.created = await site({ createdAt: "-3 hours", siteCreatedAt: "-1 hour" });
  pending.done = await site({
    status: "completed",
    createdAt: "-2 hours",
    siteCreatedAt: "-1 hour",
  });

  const done = { status: "completed" as const };
  sleep.asleepAsked = await site({
    ...done,
    siteCreatedAt: "-2 days",
    wakeRequestedAt: "-1 minute",
  });
  sleep.awakeAsked = await site({
    ...done,
    siteCreatedAt: "-2 days",
    schedulerEnabled: true,
    wakeRequestedAt: "-1 minute",
  });
  sleep.notCreatedAsked = await site({ ...done, wakeRequestedAt: "-1 minute" });
  sleep.asleepNotAsked = await site({ ...done, siteCreatedAt: "-2 days" });

  idle.oldActivity = await site({
    ...done,
    siteCreatedAt: "-60 days",
    schedulerEnabled: true,
    lastFinanceActivityAt: "-31 days",
  });
  idle.neverUsedOld = await site({ ...done, siteCreatedAt: "-40 days", schedulerEnabled: true });
  idle.recentActivity = await site({
    ...done,
    siteCreatedAt: "-60 days",
    schedulerEnabled: true,
    lastFinanceActivityAt: "-5 days",
  });
  idle.asleepOld = await site({
    ...done,
    siteCreatedAt: "-60 days",
    lastFinanceActivityAt: "-50 days",
  });

  const created = createTestApp({ database: db.sql, erpnextAgentToken: TOKEN });
  const bare = createTestApp({ database: db.sql });
  await Promise.all([created.ready, bare.ready]);
  harness = created;
  unmounted = bare;
}, 120_000);

afterAll(async () => {
  harness?.keyStore.destroy();
  unmounted?.keyStore.destroy();
  if (db?.cleanup) await db.cleanup();
});

describeDb("ERPNext agent API: authentication and mounting", () => {
  const routes: ["GET" | "POST", string][] = [
    ["GET", "/sites/pending"],
    ["GET", "/sites/wake"],
    ["GET", "/sites/idle"],
    ["POST", `/sites/${crypto.randomUUID()}/created`],
    ["POST", `/sites/${crypto.randomUUID()}/failed`],
    ["POST", `/sites/${crypto.randomUUID()}/woken`],
    ["POST", `/sites/${crypto.randomUUID()}/slept`],
  ];

  test("no token: 401 on every route", async () => {
    for (const [method, path] of routes) {
      const res = await call(method, path, { token: null, body: { error: "x" } });
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(res.headers.get("content-type")).toBe("application/problem+json");
    }
  });

  test("wrong token: 401 on every route, before any validation", async () => {
    for (const [method, path] of routes) {
      const res = await call(method, path, { token: `${TOKEN}x` });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
    // A malformed id is still a 401 to a caller without the token.
    expect((await call("POST", "/sites/not-a-uuid/created", { token: "nope" })).status).toBe(401);
  });

  test("a token under another scheme, or a school user's JWT, is refused", async () => {
    const basic = await harness!.app.request(`${BASE}/sites/pending`, {
      headers: { authorization: `Basic ${TOKEN}` },
    });
    expect(basic.status).toBe(401);

    const tenant = await createFullTenant(db.sql);
    const jwt = await mintTestToken(harness!.keyStore, {
      userId: tenant.users[ROLES.ORG_ADMIN]!.id,
      schoolId: tenant.schoolId,
      roles: [ROLES.ORG_ADMIN],
    });
    expect((await call("GET", "/sites/pending", { token: jwt })).status).toBe(401);
  });

  test("not mounted without ERPNEXT_AGENT_TOKEN: 404", async () => {
    for (const [method, path] of routes) {
      const res = await unmounted!.app.request(`${BASE}${path}`, {
        method,
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: method === "POST" ? JSON.stringify({ error: "x" }) : undefined,
      });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
  });

  test("rate limited under an explicit existing class", () => {
    expect(ROUTE_CLASS_MAP["/api/internal/erpnext/*"]).toBe("default");
    expect(resolveRouteClass(`${BASE}/sites/pending`)).toBe("default");
  });
});

describeDb("GET /sites/pending", () => {
  test("waiting sites, and failed ones more than 10 minutes old, oldest first, with the contract shape", async () => {
    const res = await call("GET", "/sites/pending");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sites: Record<string, unknown>[] };

    const waitingSchool = pending.waiting;
    expect(body.sites).toEqual([
      {
        id: waitingSchool.id,
        school_id: waitingSchool.schoolId,
        site_name: waitingSchool.siteName,
        company_name: expect.stringMatching(/^Company /) as unknown as string,
        company_abbr: "TEST",
        currency_code: "JOD",
        country_code: "JO",
      },
      {
        id: pending.failedLongAgo.id,
        school_id: pending.failedLongAgo.schoolId,
        site_name: pending.failedLongAgo.siteName,
        company_name: expect.stringMatching(/^Company /) as unknown as string,
        company_abbr: "TEST",
        currency_code: "SAR",
        country_code: "SA",
      },
    ]);
    // Exactly the contract's keys: nothing else (no personal data, no internal state).
    expect(Object.keys(body.sites[0]!).sort()).toEqual([
      "company_abbr",
      "company_name",
      "country_code",
      "currency_code",
      "id",
      "school_id",
      "site_name",
    ]);
  });

  test("a failed site is offered again once 10 minutes have passed", async () => {
    await db.sql`
      UPDATE app.erpnext_site_configs SET updated_at = now() - interval '10 minutes 1 second'
      WHERE id = ${pending.failedRecently.id}::uuid
    `;
    const ids = (await sites("/sites/pending")).map((s) => s.id);
    expect(ids).toEqual([pending.waiting.id, pending.failedLongAgo.id, pending.failedRecently.id]);
  });

  test("at most 5, oldest first", async () => {
    const older: SiteFixture[] = [];
    for (let day = 10; day >= 5; day -= 1) older.push(await site({ createdAt: `-${day} days` }));

    const ids = (await sites("/sites/pending")).map((s) => s.id);
    expect(ids).toEqual(older.slice(0, 5).map((s) => s.id));

    // Leave them created, so the later tests see only the original fixtures.
    await db.sql`
      UPDATE app.erpnext_site_configs SET site_created_at = now()
      WHERE id = ANY(${older.map((s) => s.id)}::uuid[])
    `;
  });
});

describeDb("GET /sites/wake and GET /sites/idle", () => {
  test("wake: created, asleep, and asked to wake", async () => {
    expect(await sites("/sites/wake")).toEqual([
      { id: sleep.asleepAsked.id, site_name: sleep.asleepAsked.siteName },
    ]);
  });

  test("idle: awake, and no finance activity (or no use since creation) for 30 days", async () => {
    const found = await sites("/sites/idle");
    expect(found.map((s) => s.id).sort()).toEqual(
      [idle.oldActivity.id, idle.neverUsedOld.id].sort(),
    );
    expect(found.find((s) => s.id === idle.oldActivity.id)).toEqual({
      id: idle.oldActivity.id,
      site_name: idle.oldActivity.siteName,
    });
  });

  test("idle: 29 days is not idle", async () => {
    await db.sql`
      UPDATE app.erpnext_site_configs SET last_finance_activity_at = now() - interval '29 days'
      WHERE id = ${idle.oldActivity.id}::uuid
    `;
    expect((await sites("/sites/idle")).map((s) => s.id)).toEqual([idle.neverUsedOld.id]);
  });
});

describeDb("POST /sites/{id}/...", () => {
  async function auditRows(id: string) {
    return db.sql<
      {
        school_id: string;
        actor_id: string | null;
        action: string;
        new_values: Record<string, unknown>;
      }[]
    >`
      SELECT school_id, actor_id, action::text AS action, new_values
      FROM app.audit_logs
      WHERE target_table = 'erpnext_site_configs' AND target_id = ${id}::uuid
      ORDER BY created_at
    `;
  }

  test("failed: status failed with the error, 204", async () => {
    const res = await call("POST", `/sites/${pending.waiting.id}/failed`, {
      body: { error: "bench new-site exited 1" },
    });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    const after = await row(pending.waiting.id);
    expect(after.status).toBe("failed");
    expect(after.last_error).toBe("bench new-site exited 1");
    // Just failed: not offered again for 10 minutes.
    expect((await sites("/sites/pending")).map((s) => s.id)).not.toContain(pending.waiting.id);
  });

  test("failed: the error is required and at most 2000 characters", async () => {
    const path = `/sites/${pending.waiting.id}/failed`;
    expect((await call("POST", path, {})).status).toBe(400);
    expect((await call("POST", path, { body: {} })).status).toBe(400);
    expect((await call("POST", path, { body: { error: "" } })).status).toBe(400);
    expect((await call("POST", path, { body: { error: "x".repeat(2001) } })).status).toBe(400);
    expect((await call("POST", path, { body: { error: "x".repeat(2000) } })).status).toBe(204);
  });

  test("created: site_created_at set, asleep, error cleared, back to pending, 204", async () => {
    const res = await call("POST", `/sites/${pending.waiting.id}/created`);
    expect(res.status).toBe(204);
    const after = await row(pending.waiting.id);
    expect(after.status).toBe("pending");
    expect(after.last_error).toBeNull();
    expect(after.site_created_at).not.toBeNull();
    expect(after.scheduler_enabled).toBe(false);
    // Created: no longer pending.
    expect((await sites("/sites/pending")).map((s) => s.id)).not.toContain(pending.waiting.id);
  });

  test("woken: scheduler on and the wake request cleared, 204", async () => {
    const res = await call("POST", `/sites/${sleep.asleepAsked.id}/woken`);
    expect(res.status).toBe(204);
    const after = await row(sleep.asleepAsked.id);
    expect(after.scheduler_enabled).toBe(true);
    expect(after.wake_requested_at).toBeNull();
    expect(await sites("/sites/wake")).toEqual([]);
  });

  test("slept: scheduler off, 204", async () => {
    const res = await call("POST", `/sites/${idle.neverUsedOld.id}/slept`);
    expect(res.status).toBe(204);
    expect((await row(idle.neverUsedOld.id)).scheduler_enabled).toBe(false);
    expect(await sites("/sites/idle")).toEqual([]);
  });

  test("each report writes an audit row in the owning school, with no actor and no error text", async () => {
    const rows = await auditRows(pending.waiting.id);
    expect(rows.map((r) => r.new_values.agent_report)).toEqual(["failed", "failed", "created"]);
    for (const r of rows) {
      expect(r.school_id).toBe(pending.waiting.schoolId);
      expect(r.actor_id).toBeNull();
      expect(r.action).toBe("update");
      expect(JSON.stringify(r.new_values)).not.toContain("bench new-site");
    }
    expect((await auditRows(sleep.asleepAsked.id)).map((r) => r.new_values.agent_report)).toEqual([
      "woken",
    ]);
  });

  test("an unknown id: 404 on every report, and nothing written", async () => {
    const unknown = crypto.randomUUID();
    for (const report of ["created", "woken", "slept"]) {
      const res = await call("POST", `/sites/${unknown}/${report}`);
      expect(res.status, report).toBe(404);
      expect(res.headers.get("content-type")).toBe("application/problem+json");
    }
    expect((await call("POST", `/sites/${unknown}/failed`, { body: { error: "x" } })).status).toBe(
      404,
    );
    expect(await auditRows(unknown)).toHaveLength(0);
  });

  test("a malformed id: 400", async () => {
    expect((await call("POST", "/sites/not-a-uuid/created")).status).toBe(400);
    expect((await call("POST", "/sites/not-a-uuid/failed", { body: { error: "x" } })).status).toBe(
      400,
    );
  });
});
