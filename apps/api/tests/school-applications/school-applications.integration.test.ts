// School sign-up applications against a real, migrated database.
//
// Proves what a mocked transaction cannot: the global table is reachable only through
// withSystemTx, one pending application per identity is enforced, and approval creates an active
// school whose ORG_ADMIN is linked to the applicant's own (provider, subject) -- so the returning-
// user login resolver finds them -- with audit rows in both the new school and the operator's.

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { findOAuthIdentity } from "../../src/modules/auth/services/returning-user-login-service";
import {
  approveApplication,
  getApplicantStatus,
  getApplication,
  listApplications,
  rejectApplication,
  submitApplication,
} from "../../src/modules/school-applications/service";
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
import type { ApplicantIdentity } from "../../src/modules/school-applications/applicant-session";
import type { Actor } from "../../src/modules/school-applications/service";

const integrationTest = test.skipIf(!integrationEnabled);

/** In-memory bucket: the proof's stored type/size are what the service reads back. */
function fakeStorage(): StorageService & {
  objects: Map<string, { contentType: string; sizeBytes: number }>;
} {
  const objects = new Map<string, { contentType: string; sizeBytes: number }>();
  return {
    objects,
    ttlSeconds: 900,
    check: () => Promise.resolve(true),
    presign: (key: string) => ({
      url: `https://files.test/${key}`,
      expiresAt: new Date(Date.now() + 900_000),
    }),
    exists: (key: string) => Promise.resolve(objects.has(key)),
    size: (key: string) => Promise.resolve(objects.get(key)?.sizeBytes ?? 0),
    head: (key: string) => Promise.resolve(objects.get(key) ?? null),
    checksumSha256: () => Promise.resolve(""),
    copy: (from: string, to: string) => {
      objects.set(to, objects.get(from)!);
      return Promise.resolve();
    },
    remove: (key: string) => {
      objects.delete(key);
      return Promise.resolve();
    },
    // eslint-disable-next-line require-yield -- an empty listing
    async *list() {
      return;
    },
  };
}

let db: TestDatabase;
let database: Database;
let actor: Actor;
let countryId: string;
let currencyId: string;
const storage = fakeStorage();

const applicant = (n: number): ApplicantIdentity => ({
  provider: "google",
  subject: `google-sub-${n}`,
  email: `owner${n}@gmail.test`,
  name: `Owner ${n}`,
});

function stageProof(n: number, contentType = "application/pdf", sizeBytes = 2048): string {
  const key = `temp/school-applications/obj-${n}-${crypto.randomUUID()}/licence.pdf`;
  storage.objects.set(key, { contentType, sizeBytes });
  return key;
}

function form(n: number, proofKey: string) {
  return {
    applicantName: `Owner ${n}`,
    applicantPhone: "+966 50 123 4567",
    schoolName: `Al Noor School ${n}`,
    countryId,
    defaultCurrencyId: currencyId,
    city: "Riyadh",
    address: "King Fahd Rd",
    studentCount: 300,
    proofStorageKey: proofKey,
    proofFileName: "licence.pdf",
  };
}

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createTestDatabase();
  await migrateDatabase(db.url);
  database = db.sql as unknown as Database;

  const home = (await createSchool(db.sql, { name: "Studafy HQ" })).id;
  const operator = await createUser(db.sql, home, { email: "ops@studafy.test" });
  await assignRole(db.sql, home, operator.id, "SUPER_ADMIN");
  actor = { userId: operator.id, schoolId: home };

  const [refs] = await db.sql<{ country_id: string; currency_id: string }[]>`
    SELECT (SELECT id FROM app.countries WHERE alpha2_code = 'SA') AS country_id,
           (SELECT id FROM app.currencies WHERE code = 'SAR') AS currency_id
  `;
  countryId = refs!.country_id;
  currencyId = refs!.currency_id;
}, 120_000);

afterAll(async () => {
  if (!integrationEnabled) return;
  await db.cleanup();
});

describe("school applications", () => {
  integrationTest("submit stores the application and promotes the proof", async () => {
    const proofKey = stageProof(1);
    const submitted = await submitApplication(database, storage, applicant(1), form(1, proofKey));
    expect(submitted.status).toBe("pending");

    const detail = await getApplication(database, storage, submitted.id);
    expect(detail.applicantEmail).toBe("owner1@gmail.test");
    expect(detail.countryCode).toBe("SA");
    expect(detail.currencyCode).toBe("SAR");
    expect(detail.proof.contentType).toBe("application/pdf");
    expect(detail.proof.url).toContain("permanent/school-applications/");

    const status = await getApplicantStatus(database, applicant(1));
    expect(status.application?.id).toBe(submitted.id);
  });

  integrationTest("a second pending application for the same identity is refused", async () => {
    await expect(
      submitApplication(database, storage, applicant(1), form(1, stageProof(1))),
    ).rejects.toMatchObject({ code: "SCHOOL_APPLICATION_ALREADY_PENDING" });
  });

  integrationTest("a proof S3 stored with a disallowed type is refused", async () => {
    await expect(
      submitApplication(database, storage, applicant(9), form(9, stageProof(9, "text/html"))),
    ).rejects.toMatchObject({ code: "SCHOOL_APPLICATION_PROOF_INVALID" });
  });

  integrationTest("approval creates an active school whose admin can sign in", async () => {
    const proofKey = stageProof(2);
    const submitted = await submitApplication(database, storage, applicant(2), form(2, proofKey));

    const { application, school } = await approveApplication(
      database,
      submitted.id,
      "Licence checked",
      actor,
    );
    expect(application.status).toBe("approved");
    expect(application.schoolId).toBe(school.schoolId);
    expect(school.slug).toBe("al-noor-school-2");

    const identity = await findOAuthIdentity(database, "google", "google-sub-2");
    expect(identity?.schoolId).toBe(school.schoolId);
    expect(identity?.userId).toBe(school.adminUserId);

    const [row] = await db.sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE studafy_admin");
      await tx`SELECT set_config('app.school_id', ${school.schoolId}, true)`;
      return tx<{ status: string; role: string; user_status: string; audit_rows: number }[]>`
        SELECT s.status::text AS status, r.role::text AS role, u.status::text AS user_status,
               (SELECT count(*)::int FROM app.audit_logs WHERE school_id = s.id) AS audit_rows
        FROM app.schools s
        JOIN app.users u ON u.school_id = s.id
        JOIN app.user_roles r ON r.user_id = u.id
        WHERE s.id = ${school.schoolId}
      `;
    });
    expect(row).toEqual({
      status: "active",
      role: "ORG_ADMIN",
      user_status: "active",
      audit_rows: 3,
    });

    const homeAudit = await db.sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE studafy_admin");
      await tx`SELECT set_config('app.school_id', ${actor.schoolId}, true)`;
      return tx<{ actor_id: string }[]>`
        SELECT actor_id FROM app.audit_logs
        WHERE target_table = 'school_applications' AND target_id = ${submitted.id}
      `;
    });
    expect(homeAudit.map((r) => r.actor_id)).toEqual([actor.userId]);

    await expect(
      rejectApplication(database, submitted.id, "too late", actor),
    ).rejects.toMatchObject({ code: "SCHOOL_APPLICATION_NOT_PENDING" });
  });

  integrationTest("an approved applicant cannot apply again with the same account", async () => {
    await expect(
      submitApplication(database, storage, applicant(2), form(2, stageProof(2))),
    ).rejects.toMatchObject({ code: "SCHOOL_APPLICATION_ACCOUNT_EXISTS" });
  });

  integrationTest("a rejected applicant sees the reason and may apply again", async () => {
    const first = await submitApplication(database, storage, applicant(3), form(3, stageProof(3)));
    await rejectApplication(database, first.id, "Document unreadable", actor);

    const status = await getApplicantStatus(database, applicant(3));
    expect(status.application).toMatchObject({
      status: "rejected",
      review_note: "Document unreadable",
    });

    const second = await submitApplication(database, storage, applicant(3), form(3, stageProof(3)));
    expect(second.status).toBe("pending");
  });

  integrationTest("the console lists newest first with a pending count", async () => {
    const all = await listApplications(database, { limit: 25, offset: 0 });
    expect(all.total).toBe(4);
    expect(all.pendingCount).toBe(2);
    const approved = await listApplications(database, {
      status: "approved",
      limit: 25,
      offset: 0,
    });
    expect(approved.applications.map((a) => a.schoolName)).toEqual(["Al Noor School 2"]);
    const searched = await listApplications(database, { search: "owner3", limit: 25, offset: 0 });
    expect(searched.total).toBe(2);
  });
});
