/**
 * QA-022: a Sales Invoice is created in ERPNext at most once per idempotency key.
 *
 * ERPNext does not deduplicate POSTs. The worker client used to retry every method on a timeout,
 * a network error or a 5xx, so an invoice that ERPNext created but answered late (or behind a
 * proxy 502) was POSTed again: a second bill to the same parent. A worker killed after the POST but
 * before its transaction committed lost the mapping row, and the BullMQ retry POSTed once more.
 *
 * Now the client never auto-retries a POST, every invoice carries its key in the unique
 * `custom_studafy_idempotency_key` field, and `generateInvoice` looks the key up in ERPNext before
 * it POSTs, adopting an invoice that already exists.
 *
 * The client tests run anywhere; the generateInvoice tests need TEST_DATABASE_URL.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { withSystemTenantTx } from "../../../db/tenant-tx";
import { ErpNextClient, ErpNextError } from "../erpnext-client";
import { generateInvoice } from "../invoice.service";

import type { Sql } from "postgres";

const IDEMPOTENCY_FIELD = "custom_studafy_idempotency_key";
const databaseUrl = process.env.TEST_DATABASE_URL;
const dbTest = test.skipIf(!databaseUrl);

type PostBehaviour = "ok" | "create-then-502" | "reject-400";

/** A Sales Invoice store that speaks the slice of Frappe's REST API the worker uses. */
function fakeErpNext() {
  const invoices = new Map<string, Record<string, unknown>>();
  const requests: { method: string; path: string }[] = [];
  let script: PostBehaviour[] = [];
  let getStatus: number | null = null;
  let sequence = 0;

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      requests.push({ method: request.method, path: url.pathname });
      const base = "/api/resource/Sales%20Invoice";
      if (request.method === "GET" && getStatus !== null) {
        return Response.json({ message: "upstream down" }, { status: getStatus });
      }
      if (request.method === "GET" && url.pathname === base) {
        const filters = JSON.parse(url.searchParams.get("filters") ?? "[]") as [
          string,
          string,
          string,
        ][];
        const rows = [...invoices.values()].filter((doc) =>
          filters.every(([field, op, value]) => op === "=" && doc[field] === value),
        );
        return Response.json({ data: rows.map((doc) => ({ name: doc.name })) });
      }
      if (request.method === "GET" && url.pathname.startsWith(`${base}/`)) {
        const doc = invoices.get(decodeURIComponent(url.pathname.slice(base.length + 1)));
        return doc
          ? Response.json({ data: doc })
          : Response.json({ message: "not found" }, { status: 404 });
      }
      if (request.method === "POST" && url.pathname === base) {
        const behaviour = script.shift() ?? "ok";
        if (behaviour === "reject-400") {
          return Response.json({ message: "Customer missing" }, { status: 400 });
        }
        const body = (await request.json()) as Record<string, unknown>;
        const key = body[IDEMPOTENCY_FIELD];
        if (
          typeof key === "string" &&
          [...invoices.values()].some((doc) => doc[IDEMPOTENCY_FIELD] === key)
        ) {
          // The field is unique on the site: a duplicate key is refused like Frappe's DuplicateEntryError.
          return Response.json({ exc_type: "DuplicateEntryError" }, { status: 409 });
        }
        sequence += 1;
        const name = `ACC-SINV-2026-${String(sequence).padStart(5, "0")}`;
        const doc = { ...body, name, docstatus: 0, grand_total: 1000, outstanding_amount: 1000 };
        invoices.set(name, doc);
        return behaviour === "create-then-502"
          ? new Response("Bad Gateway", { status: 502 })
          : Response.json({ data: doc });
      }
      return Response.json({ message: "unexpected" }, { status: 500 });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    invoices,
    requests,
    posts: () => requests.filter((r) => r.method === "POST").length,
    script(...behaviours: PostBehaviour[]) {
      script = behaviours;
    },
    failGets(status: number | null) {
      getStatus = status;
    },
    stop: () => server.stop(true),
  };
}

const erp = fakeErpNext();
afterAll(() => erp.stop());

describe("ERPNext worker client retry policy (QA-022)", () => {
  const client = () =>
    new ErpNextClient({ baseUrl: erp.url, apiKey: "k:s", siteHost: "school.erpnext.test" });

  test("a POST answered with a 5xx is sent exactly once", async () => {
    erp.script("create-then-502");
    const before = erp.posts();
    const error = await client()
      .post("/api/resource/Sales%20Invoice", { customer: "C-1" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ErpNextError);
    expect(erp.posts() - before).toBe(1);
  });

  test("a GET is still retried on a 5xx", async () => {
    erp.failGets(503);
    const before = erp.requests.length;
    await client()
      .get("/api/resource/Sales%20Invoice")
      .catch(() => undefined);
    erp.failGets(null);
    expect(erp.requests.length - before).toBe(3);
  });
});

let db: Sql | undefined;
let schoolId = "";
let studentId = "";
const FEE_STRUCTURE = "FS-QA022";

beforeAll(async () => {
  if (!databaseUrl) return;
  db = postgres(databaseUrl, { max: 4, ssl: false, prepare: false });
  const slug = `qa022-${crypto.randomUUID().slice(0, 8)}`;
  schoolId = await db.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    const [school] = await tx<{ id: string }[]>`
      INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
      VALUES (
        ${slug}, ${slug}, ${`${slug}@admin.local`}, ${`${slug}@admin.local`},
        (SELECT id FROM app.countries WHERE alpha2_code = 'US'),
        (SELECT id FROM app.currencies WHERE code = 'USD')
      )
      RETURNING id
    `;
    return school!.id;
  });
  studentId = await withSystemTenantTx(db, { schoolId }, async (tx) => {
    await tx`
      INSERT INTO app.erpnext_site_configs (school_id, site_name, company_name, company_abbr, status)
      VALUES (${schoolId}::uuid, ${`${slug}.erpnext.test`}, ${slug}, 'QA', 'completed')
    `;
    await tx`
      INSERT INTO app.fee_structure_cache (
        school_id, currency_id, erpnext_docname, erpnext_status, title, total_amount_minor,
        erpnext_payload, last_synced_at
      ) VALUES (
        ${schoolId}::uuid, (SELECT id FROM app.currencies WHERE code = 'USD'), ${FEE_STRUCTURE},
        'submitted', 'Tuition', 100000,
        ${tx.json({ components: [{ fee_category: "Tuition", amount: 1000 }] })}::jsonb,
        CURRENT_TIMESTAMP
      )
    `;
    const [user] = await tx<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email, status)
      VALUES (${schoolId}::uuid, ${`kid@${slug}.local`}, ${`kid@${slug}.local`}, 'active')
      RETURNING id
    `;
    const [student] = await tx<{ id: string }[]>`
      INSERT INTO app.students (school_id, user_id, admission_number, first_name, last_name)
      VALUES (${schoolId}::uuid, ${user!.id}::uuid, 'QA-022-1', 'A', 'B') RETURNING id
    `;
    return student!.id;
  });
}, 30_000);

afterAll(async () => {
  await db?.end({ timeout: 5 });
});

function job(idempotencyKey: string) {
  return {
    version: 1 as const,
    schoolId,
    studentId,
    feeStructureErpnextName: FEE_STRUCTURE,
    idempotencyKey,
    periodTitle: "Term 1",
  };
}

function generate(idempotencyKey: string) {
  return withSystemTenantTx(db!, { schoolId }, (tx) =>
    generateInvoice(tx, schoolId, job(idempotencyKey), erp.url, "k:s"),
  );
}

function invoicesFor(key: string) {
  return [...erp.invoices.values()].filter((doc) => doc[IDEMPOTENCY_FIELD] === key);
}

async function mappedDocname(key: string): Promise<string | null> {
  const [row] = await withSystemTenantTx(
    db!,
    { schoolId },
    (tx) => tx<{ erpnext_docname: string | null }[]>`
      SELECT erpnext_docname FROM app.erpnext_id_mappings
      WHERE school_id = ${schoolId}::uuid AND entity = 'invoice' AND studafy_id = ${key}::uuid
    `,
  );
  return row?.erpnext_docname ?? null;
}

describe("generateInvoice creates each invoice once (QA-022)", () => {
  dbTest("an invoice created behind a 502 is adopted by the retry, not billed twice", async () => {
    const key = crypto.randomUUID();
    erp.script("create-then-502", "ok", "ok");

    await expect(generate(key)).rejects.toThrow();
    expect(invoicesFor(key)).toHaveLength(1);

    const retried = await generate(key);
    expect(invoicesFor(key)).toHaveLength(1);
    expect(retried.erpnextDocname).toBe(invoicesFor(key)[0]!.name as string);
    expect(await mappedDocname(key)).toBe(retried.erpnextDocname);
  });

  dbTest("a crash after the POST but before COMMIT does not create a second invoice", async () => {
    const key = crypto.randomUUID();
    erp.script("ok", "ok");

    await expect(
      withSystemTenantTx(db!, { schoolId }, async (tx) => {
        await generateInvoice(tx, schoolId, job(key), erp.url, "k:s");
        throw new Error("SIGKILL before COMMIT");
      }),
    ).rejects.toThrow("SIGKILL");
    expect(await mappedDocname(key)).toBeNull();

    const retried = await generate(key);
    expect(invoicesFor(key)).toHaveLength(1);
    expect(await mappedDocname(key)).toBe(retried.erpnextDocname);
  });

  dbTest("when ERPNext cannot be asked whether the invoice exists, nothing is POSTed", async () => {
    const key = crypto.randomUUID();
    const before = erp.posts();
    erp.failGets(503);
    await expect(generate(key)).rejects.toThrow();
    erp.failGets(null);
    expect(erp.posts()).toBe(before);
  });

  dbTest("a clean first run still creates exactly one invoice stamped with its key", async () => {
    const key = crypto.randomUUID();
    erp.script("ok");
    const result = await generate(key);
    expect(result.status).toBe("created");
    expect(invoicesFor(key)).toHaveLength(1);
    expect((await generate(key)).status).toBe("already_exists");
    expect(invoicesFor(key)).toHaveLength(1);
  });
});
