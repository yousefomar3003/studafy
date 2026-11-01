/**
 * The school's sales tax (VAT) settings (000173) and what an invoice shows of them: off by
 * default, readable by finance, saved only by a school admin, refused when turned on without a
 * rate or an ERPNext account. Requires a live PostgreSQL instance, gated on TEST_DATABASE_URL.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/finance/tax-settings-http.test.ts
 */

import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  assignRole,
  authenticatedRequest,
  createFullTenant,
  createTestApp,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import type { TenantFixture, TestApp, TestDatabase } from "../harness";
import type { Role } from "@studafy/constants";

const describeDb = integrationEnabled ? describe : describe.skip;

let database: TestDatabase | undefined;
let harness: TestApp | undefined;

beforeAll(async () => {
  if (!integrationEnabled) return;
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

interface Actor {
  schoolId: string;
  userId: string;
  roles: Role[];
}

const PATH = "/api/finance/tax-settings";

const VAT = {
  is_enabled: true,
  tax_name: "VAT",
  rate: 5,
  erpnext_account_head: "VAT 5% - SCH",
  registration_number: "100234567800003",
  exempt_fee_categories: ["Tuition", "Tuition"],
};

async function financeOf(fixture: TenantFixture): Promise<Actor> {
  const user = await createUser(database!.sql, fixture.schoolId, {
    email: `finance-${crypto.randomUUID().slice(0, 8)}@test.local`,
  });
  await assignRole(database!.sql, fixture.schoolId, user.id, ROLES.FINANCE);
  return { schoolId: fixture.schoolId, userId: user.id, roles: [ROLES.FINANCE] };
}

function adminOf(fixture: TenantFixture): Actor {
  return {
    schoolId: fixture.schoolId,
    userId: fixture.users.ORG_ADMIN.id,
    roles: [ROLES.ORG_ADMIN],
  };
}

function send(actor: Actor, method: "GET" | "PUT", path: string, body?: unknown) {
  return authenticatedRequest(harness!, method, path, actor, {
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describeDb("sales tax settings", () => {
  test("off by default; finance reads them but only a school admin saves", async () => {
    const fixture = await createFullTenant(database!.sql);
    const finance = await financeOf(fixture);

    const initial = await send(finance, "GET", PATH);
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({ configured: false, is_enabled: false, rate: 0 });

    expect((await send(finance, "PUT", PATH, VAT)).status).toBe(403);

    const saved = await send(adminOf(fixture), "PUT", PATH, VAT);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      configured: true,
      is_enabled: true,
      rate: 5,
      erpnext_account_head: "VAT 5% - SCH",
      registration_number: "100234567800003",
      prices_include_tax: false,
      exempt_fee_categories: ["Tuition"],
      updated_by: fixture.users.ORG_ADMIN.id,
    });
    expect(await (await send(finance, "GET", PATH)).json()).toMatchObject({ is_enabled: true });

    const [audit] = await database!.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM app.audit_logs
      WHERE school_id = ${fixture.schoolId}::uuid AND target_table = 'school_tax_settings'
    `;
    expect(audit!.count).toBeGreaterThan(0);
  });

  test("turning tax on needs a rate and an account", async () => {
    const fixture = await createFullTenant(database!.sql);
    const admin = adminOf(fixture);
    expect((await send(admin, "PUT", PATH, { ...VAT, rate: 0 })).status).toBe(400);
    expect((await send(admin, "PUT", PATH, { ...VAT, erpnext_account_head: null })).status).toBe(
      400,
    );
    // Off, nothing else is needed.
    expect((await send(admin, "PUT", PATH, { is_enabled: false, rate: 0 })).status).toBe(200);
  });

  test("another school's settings are its own", async () => {
    const fixture = await createFullTenant(database!.sql);
    const other = await createFullTenant(database!.sql);
    await send(adminOf(other), "PUT", PATH, VAT);
    expect(await (await send(adminOf(fixture), "GET", PATH)).json()).toMatchObject({
      configured: false,
    });
  });

  test("an invoice shows ERPNext's tax rows and the school's registration number", async () => {
    const fixture = await createFullTenant(database!.sql);
    const finance = await financeOf(fixture);
    await send(adminOf(fixture), "PUT", PATH, VAT);
    const [currency] = await database!.sql<{ id: string }[]>`
      SELECT id FROM app.currencies WHERE code = 'JOD'
    `;
    const payload = {
      net_total: 1200,
      items: [
        { item_code: "Tuition", qty: 1, amount: 1000 },
        { item_code: "Transport", qty: 1, amount: 200 },
      ],
      taxes: [{ description: "VAT 5%", rate: 5, tax_amount: 10, account_head: "VAT 5% - SCH" }],
    };
    const [row] = await database!.sql<{ id: string }[]>`
      INSERT INTO app.invoice_cache
        (school_id, student_id, currency_id, erpnext_docname, erpnext_status, total_amount_minor,
         outstanding_amount_minor, issued_date, last_synced_at, erpnext_payload)
      VALUES (${fixture.schoolId}::uuid, ${fixture.students[0]!.id}::uuid, ${currency!.id}::uuid,
              'INV-VAT', 'submitted', 1210000, 1210000, '2026-09-01', now(),
              ${database!.sql.json(payload)}::jsonb)
      RETURNING id
    `;

    const detail = await send(finance, "GET", `/api/finance/invoices/${row!.id}`);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      net_total: 1200,
      taxes: [{ description: "VAT 5%", rate: 5, amount: 10 }],
      tax_registration_number: "100234567800003",
    });
  });
});
