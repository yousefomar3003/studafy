// The platform console's per-school administration (profile edit, usage panel, usage sorts and
// filters, whole-school exports) against a real, migrated database. Tenant RLS is FORCEd onto
// studafy_admin, so only a real database proves each read sees the one school it armed.

import { dsrExportArchiveKey } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { HTTPException } from "hono/http-exception";

import {
  createSchoolExport,
  getSchoolExport,
  getSchoolUsage,
  listSchoolExports,
  updateSchoolProfile,
} from "../../src/modules/platform/school-admin-service";
import { listSchools } from "../../src/modules/platform/service";
import {
  assignRole,
  createSchool,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
  type TestDatabase,
} from "../harness";

import type { Database } from "../../src/db/client";
import type { StorageService } from "../../src/lib/storage";
import type { Actor } from "../../src/modules/platform/service";
import type { Queue } from "bullmq";

const integrationTest = test.skipIf(!integrationEnabled);

interface Fixture {
  home: string;
  alpha: string;
  beta: string;
  gamma: string;
  actor: Actor;
}

let db: TestDatabase;
let fixture: Fixture;

const GIB = 1024 * 1024 * 1024;

async function asAdmin<T>(schoolId: string | null, run: (tx: TestDatabase["sql"]) => Promise<T>) {
  return db.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    if (schoolId) await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    return run(tx as unknown as TestDatabase["sql"]);
  }) as Promise<T>;
}

async function seed(sql: TestDatabase["sql"]): Promise<Fixture> {
  const home = (await createSchool(sql, { name: "Studafy HQ" })).id;
  const alpha = (await createSchool(sql, { name: "Alpha Academy" })).id;
  const beta = (await createSchool(sql, { name: "Beta School" })).id;
  const gamma = (await createSchool(sql, { name: "Gamma College" })).id;

  const operator = await createUser(sql, home, { email: "ops@studafy.test" });
  await assignRole(sql, home, operator.id, "SUPER_ADMIN");

  // Alpha: 3 active students (one signed in today), an active teacher, an invited parent.
  for (const email of ["a1@alpha.test", "a2@alpha.test", "a3@alpha.test"]) {
    const student = await createUser(sql, alpha, { email });
    await assignRole(sql, alpha, student.id, "STUDENT");
  }
  const teacher = await createUser(sql, alpha, { email: "t@alpha.test" });
  await assignRole(sql, alpha, teacher.id, "INSTRUCTOR");
  const parent = await createUser(sql, alpha, { email: "p@alpha.test", status: "invited" });
  await assignRole(sql, alpha, parent.id, "PARENT");

  // Beta: one student who last signed in 60 days ago; storage at 90% of 10 GiB.
  const betaStudent = await createUser(sql, beta, { email: "b1@beta.test" });
  await assignRole(sql, beta, betaStudent.id, "STUDENT");

  await asAdmin(alpha, async (tx) => {
    await tx`UPDATE app.users SET last_login_at = CURRENT_TIMESTAMP WHERE email = 'a1@alpha.test'`;
    await tx`
      INSERT INTO app.invitations (school_id, email, normalized_email, role, token_hash, expires_at)
      VALUES (${alpha}, 'new@alpha.test', 'new@alpha.test', 'INSTRUCTOR',
              sha256('platform-usage-invite'::bytea),
              CURRENT_TIMESTAMP + INTERVAL '7 days')
    `;
    await tx`
      INSERT INTO app.storage_usage_meters (school_id, bytes_used) VALUES (${alpha}, ${GIB})
    `;
  });
  await asAdmin(beta, async (tx) => {
    await tx`
      UPDATE app.users SET last_login_at = CURRENT_TIMESTAMP - INTERVAL '60 days'
      WHERE email = 'b1@beta.test'
    `;
    await tx`
      INSERT INTO app.storage_usage_meters (school_id, bytes_used)
      VALUES (${beta}, ${Math.round(9 * GIB)})
    `;
  });
  // Gamma has a Stripe customer: its country and currency are locked.
  await asAdmin(null, async (tx) => {
    await tx`UPDATE app.schools SET stripe_customer_id = 'cus_gamma_test' WHERE id = ${gamma}`;
  });

  return { home, alpha, beta, gamma, actor: { userId: operator.id, schoolId: home } };
}

async function auditRows(schoolId: string, table: string) {
  return asAdmin(
    schoolId,
    (tx) =>
      tx<{ action: string; actor_id: string | null; old_values: unknown; new_values: unknown }[]>`
      SELECT action::text AS action, actor_id, old_values, new_values FROM app.audit_logs
      WHERE target_table = ${table} ORDER BY created_at
    `,
  );
}

async function expectHttp(promise: Promise<unknown>, status: number) {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(HTTPException);
  expect((caught as HTTPException).status as number).toBe(status);
}

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createTestDatabase();
  await migrateDatabase(db.url);
  fixture = await seed(db.sql);
}, 120_000);

afterAll(async () => {
  if (!integrationEnabled) return;
  await db.cleanup();
});

const database = () => db.sql as unknown as Database;

describe("school profile", () => {
  integrationTest("edits name, email, language and timezone, audited in both schools", async () => {
    const detail = await updateSchoolProfile(
      database(),
      fixture.alpha,
      {
        name: "Alpha International Academy",
        email: "office@alpha.test",
        locale: "ar",
        timezone: "Asia/Amman",
        reason: "School asked by email",
      },
      fixture.actor,
    );
    expect(detail.name).toBe("Alpha International Academy");
    expect(detail.email).toBe("office@alpha.test");
    expect(detail.locale).toBe("ar");
    expect(detail.timezone).toBe("Asia/Amman");

    const inSchool = await auditRows(fixture.alpha, "schools");
    const last = inSchool.at(-1)!;
    expect(last.actor_id).toBeNull();
    expect(last.new_values).toMatchObject({
      name: "Alpha International Academy",
      locale: "ar",
      timezone: "Asia/Amman",
      reason: "School asked by email",
    });
    const inHome = await auditRows(fixture.home, "schools");
    expect(inHome.at(-1)!.actor_id).toBe(fixture.actor.userId);
  });

  integrationTest("a patch that changes nothing writes no audit row", async () => {
    const before = (await auditRows(fixture.alpha, "schools")).length;
    await updateSchoolProfile(
      database(),
      fixture.alpha,
      { name: "Alpha International Academy", reason: "No-op" },
      fixture.actor,
    );
    expect((await auditRows(fixture.alpha, "schools")).length).toBe(before);
  });

  integrationTest("refuses an email another school uses", async () => {
    await expectHttp(
      updateSchoolProfile(
        database(),
        fixture.beta,
        { email: "OFFICE@alpha.test", reason: "Typo" },
        fixture.actor,
      ),
      409,
    );
  });

  integrationTest("changes country and currency for a school with no billing", async () => {
    const detail = await updateSchoolProfile(
      database(),
      fixture.beta,
      { countryCode: "jo", currencyCode: "jod", reason: "Registered with the wrong country" },
      fixture.actor,
    );
    expect(detail.countryCode).toBe("JO");
    expect(detail.currencyCode).toBe("JOD");
  });

  integrationTest("refuses country and currency once the school has billing records", async () => {
    await expectHttp(
      updateSchoolProfile(
        database(),
        fixture.gamma,
        { currencyCode: "EUR", reason: "Wants euros" },
        fixture.actor,
      ),
      409,
    );
    // Its name can still change.
    const detail = await updateSchoolProfile(
      database(),
      fixture.gamma,
      { name: "Gamma College Amman", reason: "Rename" },
      fixture.actor,
    );
    expect(detail.name).toBe("Gamma College Amman");
  });

  integrationTest("refuses an unknown country", async () => {
    await expectHttp(
      updateSchoolProfile(
        database(),
        fixture.beta,
        { countryCode: "QQ", reason: "Test" },
        fixture.actor,
      ),
      400,
    );
  });
});

describe("school usage", () => {
  integrationTest("counts accounts, invitations, storage, activity and licence", async () => {
    const usage = await getSchoolUsage(database(), fixture.alpha);
    const byRole = Object.fromEntries(usage.people.map((row) => [row.role, row]));
    expect(byRole.STUDENT).toEqual({ role: "STUDENT", active: 3, invited: 0 });
    expect(byRole.INSTRUCTOR).toEqual({ role: "INSTRUCTOR", active: 1, invited: 0 });
    expect(byRole.PARENT).toEqual({ role: "PARENT", active: 0, invited: 1 });
    expect(usage.pendingInvitations).toBe(1);
    expect(usage.storage.bytesUsed).toBe(GIB);
    expect(usage.storage.capBytes).toBe(10 * GIB);
    expect(usage.storage.fractionUsed).toBeCloseTo(0.1, 5);
    expect(usage.activity.activeUsersLast30Days).toBe(1);
    expect(usage.activity.lastActivityAt).not.toBeNull();
    expect(usage.ai.activeSubscriptions).toBe(0);
    expect(usage.ai.tokensThisPeriod).toBe(0);
    expect(usage.ai.monthStart).toMatch(/^\d{4}-\d{2}-01$/);
    expect(usage.license).toBeNull();
  });

  integrationTest("a school's usage never includes another school's rows", async () => {
    const usage = await getSchoolUsage(database(), fixture.beta);
    expect(usage.people).toEqual([{ role: "STUDENT", active: 1, invited: 0 }]);
    expect(usage.pendingInvitations).toBe(0);
  });

  integrationTest("an unknown school is a 404", async () => {
    await expectHttp(getSchoolUsage(database(), crypto.randomUUID()), 404);
  });
});

describe("schools list usage sorts and filters", () => {
  integrationTest("sorts by students, most first", async () => {
    const { schools } = await listSchools(database(), {
      sort: "students",
      limit: 25,
      offset: 0,
    });
    expect(schools[0]!.id).toBe(fixture.alpha);
    expect(schools[0]!.students).toBe(3);
  });

  integrationTest("filters schools with no sign-in for 30 days", async () => {
    const { schools, total } = await listSchools(database(), {
      activity: "inactive30d",
      limit: 25,
      offset: 0,
    });
    const ids = schools.map((school) => school.id);
    expect(ids).toContain(fixture.beta);
    expect(ids).not.toContain(fixture.alpha);
    expect(total).toBe(ids.length);
  });

  integrationTest("filters schools near their storage cap and pages after filtering", async () => {
    const near = await listSchools(database(), { storage: "nearCap", limit: 25, offset: 0 });
    expect(near.schools.map((school) => school.id)).toEqual([fixture.beta]);
    expect(near.schools[0]!.storageBytesUsed).toBe(Math.round(9 * GIB));
    expect(near.schools[0]!.storageCapBytes).toBe(10 * GIB);

    const firstPage = await listSchools(database(), {
      sort: "storage",
      limit: 1,
      offset: 0,
    });
    expect(firstPage.schools.map((school) => school.id)).toEqual([fixture.beta]);
    expect(firstPage.total).toBe(4);
  });
});

describe("school exports", () => {
  const added: string[] = [];
  const queue = {
    add: async (_name: string, data: { requestId: string }) => {
      added.push(data.requestId);
    },
  } as unknown as Queue;
  const brokenQueue = {
    add: async () => {
      throw new Error("redis down");
    },
  } as unknown as Queue;
  const storage = {
    presign: (key: string) => ({ url: `https://files.test/${key}`, expiresAt: new Date() }),
  } as unknown as StorageService;

  integrationTest("files a platform export, queues it, and refuses a second one", async () => {
    const created = await createSchoolExport(
      database(),
      queue,
      fixture.alpha,
      "Migration to new server",
      fixture.actor,
    );
    expect(created.status).toBe("queued");
    expect(added).toContain(created.id);

    const [row] = await asAdmin(
      fixture.alpha,
      (tx) =>
        tx<{ reason: string; subject_scope: string; requested_by_user_id: string | null }[]>`
        SELECT reason::text AS reason, subject_scope::text AS subject_scope, requested_by_user_id
        FROM app.data_subject_requests WHERE id = ${created.id}
      `,
    );
    expect(row).toEqual({
      reason: "platform_export",
      subject_scope: "tenant",
      requested_by_user_id: null,
    });

    await expectHttp(
      createSchoolExport(database(), queue, fixture.alpha, "Again", fixture.actor),
      409,
    );

    const exportAudits = await auditRows(fixture.alpha, "data_subject_requests");
    expect(exportAudits.at(-1)!.action).toBe("export");
  });

  integrationTest("a completed export gets an audited download link", async () => {
    const [latest] = await listSchoolExports(database(), fixture.alpha);
    const key = dsrExportArchiveKey(fixture.alpha, latest!.id);
    await asAdmin(fixture.alpha, async (tx) => {
      await tx`
        UPDATE app.data_subject_requests
        SET status = 'completed', storage_key = ${key}, completed_at = clock_timestamp(),
            updated_at = clock_timestamp()
        WHERE id = ${latest!.id}
      `;
    });

    const listed = await listSchoolExports(database(), fixture.alpha);
    expect(listed[0]!.downloadUrl).toBeNull();
    expect(listed[0]!.expiresAt).not.toBeNull();

    const read = await getSchoolExport(
      database(),
      storage,
      fixture.alpha,
      latest!.id,
      fixture.actor,
    );
    expect(read.downloadUrl).toBe(`https://files.test/${key}`);
    const audits = await auditRows(fixture.home, "data_subject_requests");
    expect(audits.at(-1)).toMatchObject({ action: "read", actor_id: fixture.actor.userId });
  });

  integrationTest("an export that could not be queued is marked failed", async () => {
    await expectHttp(
      createSchoolExport(database(), brokenQueue, fixture.beta, "Backup", fixture.actor),
      503,
    );
    const [latest] = await listSchoolExports(database(), fixture.beta);
    expect(latest!.status).toBe("failed");
    // A failed export does not block the next one.
    const retried = await createSchoolExport(
      database(),
      queue,
      fixture.beta,
      "Backup",
      fixture.actor,
    );
    expect(retried.status).toBe("queued");
  });

  integrationTest("another school's export is not found", async () => {
    const [alphaExport] = await listSchoolExports(database(), fixture.alpha);
    await expectHttp(
      getSchoolExport(database(), storage, fixture.beta, alphaExport!.id, fixture.actor),
      404,
    );
  });

  integrationTest("the schema refuses a platform erasure", async () => {
    let failed = false;
    try {
      await asAdmin(
        fixture.alpha,
        (tx) =>
          tx`
          INSERT INTO app.data_subject_requests
            (school_id, request_type, subject_scope, reason, sla_due_at)
          VALUES (${fixture.alpha}, 'erasure', 'tenant', 'platform_export',
                  CURRENT_TIMESTAMP + INTERVAL '30 days')
        `,
      );
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });
});
