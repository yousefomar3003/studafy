// Database-backed tests for the ERPNext identity crosswalk and the fee-structure read model
// (ST-119). Self-skips without TEST_DATABASE_URL, like every other integration suite here.

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test, beforeAll, afterAll } from "bun:test";

import {
  createTestDatabase,
  migrateDatabase,
  createSchool,
  integrationEnabled,
  type TestDatabase,
} from "../../../../tests/harness";
import { CodedHttpException } from "../../../coded-http-exception";
import { EnvCredentialResolver } from "../client/credential-resolver";
import { getCurrencyByCode } from "../currency";
import { findByDocname, findByStudafyId, upsertMapping } from "../id-mappings/service";

import type { TransactionSql } from "postgres";

const describeDb = integrationEnabled ? describe : describe.skip;

let db: TestDatabase;

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createTestDatabase();
  await migrateDatabase(db.url);
});

afterAll(async () => {
  if (db?.cleanup) await db.cleanup();
});

/** Runs as studafy_app with the tenant GUC set — the same context withTenantTx establishes. */
async function withTx<T>(schoolId: string, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  let result: T | undefined;
  await db.sql.begin(async (tx) => {
    await tx`
      SELECT set_config('role', 'studafy_app', true),
             set_config('app.school_id', ${schoolId}, true)
    `;
    result = await fn(tx);
  });
  return result as T;
}

describeDb("erpnext id mappings", () => {
  test("records a crosswalk and finds it from either side", async () => {
    const school = await createSchool(db.sql);
    const localId = crypto.randomUUID();

    const created = await withTx(school.id, (tx) =>
      upsertMapping(tx, school.id, "fee_structure", localId, "FS-2026-0001"),
    );

    expect(created.entity).toBe("fee_structure");
    expect(created.erpnext_docname).toBe("FS-2026-0001");

    const byLocal = await withTx(school.id, (tx) =>
      findByStudafyId(tx, school.id, "fee_structure", localId),
    );
    const byDoc = await withTx(school.id, (tx) =>
      findByDocname(tx, school.id, "fee_structure", "FS-2026-0001"),
    );

    expect(byLocal?.studafy_id).toBe(localId);
    expect(byDoc?.studafy_id).toBe(localId);
    expect(byLocal?.id).toBe(byDoc!.id);
  });

  test("re-syncing the same document is a no-op, not a duplicate", async () => {
    const school = await createSchool(db.sql);
    const localId = crypto.randomUUID();

    const first = await withTx(school.id, (tx) =>
      upsertMapping(tx, school.id, "fee_structure", localId, "FS-2026-0002"),
    );
    const second = await withTx(school.id, (tx) =>
      upsertMapping(tx, school.id, "fee_structure", localId, "FS-2026-0002"),
    );

    expect(second.id).toBe(first.id);

    const [count] = await db.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM app.erpnext_id_mappings
      WHERE school_id = ${school.id}::uuid AND studafy_id = ${localId}::uuid
    `;
    expect(count!.n).toBe(1);
  });

  test("re-pointing a local id at a renamed ERPNext document updates in place", async () => {
    const school = await createSchool(db.sql);
    const localId = crypto.randomUUID();

    await withTx(school.id, (tx) =>
      upsertMapping(tx, school.id, "fee_structure", localId, "FS-OLD"),
    );
    const updated = await withTx(school.id, (tx) =>
      upsertMapping(tx, school.id, "fee_structure", localId, "FS-NEW"),
    );

    expect(updated.erpnext_docname).toBe("FS-NEW");
    const stale = await withTx(school.id, (tx) =>
      findByDocname(tx, school.id, "fee_structure", "FS-OLD"),
    );
    expect(stale).toBeUndefined();
  });

  test("the same ERPNext name in two schools stays two separate mappings", async () => {
    // ERPNext naming series restart per site, so 'FS-2026-0001' genuinely exists in many tenants.
    // The unique constraints are school-scoped precisely so this is not a collision.
    const schoolA = await createSchool(db.sql);
    const schoolB = await createSchool(db.sql);
    const localA = crypto.randomUUID();
    const localB = crypto.randomUUID();

    await withTx(schoolA.id, (tx) =>
      upsertMapping(tx, schoolA.id, "fee_structure", localA, "FS-2026-0001"),
    );
    await withTx(schoolB.id, (tx) =>
      upsertMapping(tx, schoolB.id, "fee_structure", localB, "FS-2026-0001"),
    );

    const fromA = await withTx(schoolA.id, (tx) =>
      findByDocname(tx, schoolA.id, "fee_structure", "FS-2026-0001"),
    );
    expect(fromA?.studafy_id).toBe(localA);

    // And school A cannot see school B's row even asking for it by name: RLS, not a WHERE clause.
    const leak = await withTx(schoolA.id, (tx) =>
      findByStudafyId(tx, schoolA.id, "fee_structure", localB),
    );
    expect(leak).toBeUndefined();
  });

  test("distinguishes entity types that share a local id", async () => {
    const school = await createSchool(db.sql);
    const localId = crypto.randomUUID();

    await withTx(school.id, (tx) => upsertMapping(tx, school.id, "fee_structure", localId, "FS-1"));
    await withTx(school.id, (tx) => upsertMapping(tx, school.id, "fee_category", localId, "CAT-1"));

    const structure = await withTx(school.id, (tx) =>
      findByStudafyId(tx, school.id, "fee_structure", localId),
    );
    const category = await withTx(school.id, (tx) =>
      findByStudafyId(tx, school.id, "fee_category", localId),
    );

    expect(structure?.erpnext_docname).toBe("FS-1");
    expect(category?.erpnext_docname).toBe("CAT-1");
  });
});

describeDb("currency lookup", () => {
  test("JOD is seeded with three minor units, not two", async () => {
    const school = await createSchool(db.sql);

    const jod = await withTx(school.id, (tx) => getCurrencyByCode(tx, "JOD"));

    expect(jod).toBeDefined();
    expect(jod!.code).toBe("JOD");
    // The assumption this whole module exists to prevent.
    expect(jod!.minorUnit).toBe(3);
  });

  test("an unknown code resolves to undefined rather than throwing", async () => {
    const school = await createSchool(db.sql);
    const missing = await withTx(school.id, (tx) => getCurrencyByCode(tx, "ZZZ"));
    expect(missing).toBeUndefined();
  });
});

describeDb("credential resolver", () => {
  /**
   * Captures the rejection *inside* the transaction rather than letting it escape `sql.begin`.
   * postgres.js does not reliably settle a `begin` whose callback threw before issuing a
   * statement, and the test hangs to its timeout instead of failing. Production is unaffected —
   * there the throw travels out of withTenantTx to the error handler on a real request.
   */
  async function resolveError(schoolId: string, resolver: EnvCredentialResolver): Promise<unknown> {
    return withTx(schoolId, async (tx) => {
      try {
        await resolver.resolve(tx, schoolId);
        return undefined;
      } catch (error) {
        return error;
      }
    });
  }

  test("refuses when the integration is not configured at all", async () => {
    const school = await createSchool(db.sql);
    const resolver = new EnvCredentialResolver({ baseUrl: undefined, apiKey: undefined });

    const error = (await resolveError(school.id, resolver)) as CodedHttpException;

    expect(error).toBeInstanceOf(CodedHttpException);
    expect(error.status).toBe(503);
    expect(error.code).toBe("ERPNEXT_NOT_CONFIGURED");
  });

  test("refuses a school whose ERPNext site has not finished provisioning", async () => {
    const school = await createSchool(db.sql);
    const resolver = new EnvCredentialResolver({ baseUrl: "https://erp.test", apiKey: "k" });

    // No erpnext_site_configs row at all: never provisioned.
    const error = (await resolveError(school.id, resolver)) as CodedHttpException;

    expect(error).toBeInstanceOf(CodedHttpException);
    expect(error.code).toBe("ERPNEXT_NOT_CONFIGURED");
  });

  test("returns the school's own site name as the Host header once provisioned", async () => {
    const school = await createSchool(db.sql);
    await db.sql`
      INSERT INTO app.erpnext_site_configs
        (school_id, site_name, company_name, company_abbr, status)
      VALUES (
        ${school.id}::uuid, ${`${school.slug}.erp.test`}, 'Test Co', 'TC', 'completed'
      )
    `;

    const resolver = new EnvCredentialResolver({
      baseUrl: "https://erp.test",
      apiKey: "global-key",
    });
    const credentials = await withTx(school.id, (tx) => resolver.resolve(tx, school.id));

    // The Host header is what selects the tenant's Frappe site; the credential is global.
    expect(credentials.siteHost).toBe(`${school.slug}.erp.test`);
    expect(credentials.apiKey).toBe("global-key");
  });
});
