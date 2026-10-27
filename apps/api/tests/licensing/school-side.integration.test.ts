/**
 * The school's side of its license, the reads session 5 of docs/billing/feature-licensing.md added,
 * against a real database: everyone in an audience with their seat status and personal subscription
 * end date, the tier catalog (features and limits, no prices), and change requests that ask for a
 * tier -- plus the routes' permissions.
 */

import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createLogger } from "../../src/logger";
import { AUTH_CHANNELS } from "../../src/modules/auth/channels";
import {
  assignSeats,
  createLicense,
  runLicenseChange,
  transitionLicense,
} from "../../src/modules/licensing";
import {
  assignRole,
  authenticatedRequest,
  createSchool,
  createStudent,
  createTestApp,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import type { LicenseActor, LicensingDeps } from "../../src/modules/licensing";
import type { TestApp, TestDatabase } from "../harness";
import type { TransactionSql } from "postgres";

const integrationTest = test.skipIf(!integrationEnabled);
const logger = createLogger({ destination: () => undefined });
const DAY = 86_400_000;

let db: TestDatabase;
let api: TestApp;
let hq: string;
let operator: LicenseActor;
let plusTier = "";
let proTier = "";
let retiredTier = "";
let teacherTier = "";

function deps(): LicensingDeps {
  return { database: db.sql, redis: null, logger, providers: { stripe: null, googlePlay: null } };
}

function change<T>(
  schoolId: string,
  actor: LicenseActor,
  fn: (tx: TransactionSql) => Promise<{ result: T; versions: Map<string, number> } | T>,
): Promise<T> {
  return runLicenseChange(deps(), schoolId, actor, async (tx) => {
    const out = (await fn(tx)) as unknown;
    if (out && typeof out === "object" && "versions" in out && "result" in out) {
      return out as { result: T; versions: Map<string, number>; pending: [] };
    }
    return { result: out as T, versions: new Map<string, number>(), pending: [] };
  }).then((r) => r.result);
}

const json = (body: unknown) => ({
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
});

function request(
  as: { schoolId: string; userId: string; roles: string[] },
  method: string,
  path: string,
  body?: unknown,
) {
  return authenticatedRequest(
    api,
    method,
    path,
    { ...as, roles: as.roles as never, channel: AUTH_CHANNELS.WEB },
    body === undefined ? undefined : json(body),
  );
}

async function createTier(body: Record<string, unknown>): Promise<string> {
  const response = await request(
    { schoolId: hq, userId: operator.userId, roles: [ROLES.SUPER_ADMIN] },
    "POST",
    "/api/platform/tiers",
    { includesAllFeatures: false, prices: [], ...body },
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createTestDatabase({ maxConnections: 8 });
  await migrateDatabase(db.url);
  const created = createTestApp({ database: db.sql });
  await created.ready;
  api = created;

  hq = (await createSchool(db.sql, { name: "Studafy HQ" })).id;
  const op = await createUser(db.sql, hq, { email: "school-side-ops@studafy.test" });
  await assignRole(db.sql, hq, op.id, "SUPER_ADMIN");
  operator = { kind: "platform", userId: op.id, homeSchoolId: hq };

  plusTier = await createTier({
    code: "student_plus_school",
    audience: "student",
    displayName: "Student Plus",
    rank: 11,
    features: [
      { key: "ai_tutor", monthlyLimit: 300 },
      { key: "study_tools", monthlyLimit: null },
    ],
  });
  proTier = await createTier({
    code: "student_pro_school",
    audience: "student",
    displayName: "Student Pro",
    rank: 12,
    includesAllFeatures: true,
    features: [{ key: "ai_tutor", monthlyLimit: 1000 }],
  });
  retiredTier = await createTier({
    code: "student_old_school",
    audience: "student",
    displayName: "Student Old",
    rank: 13,
    features: [],
  });
  await request(
    { schoolId: hq, userId: operator.userId, roles: [ROLES.SUPER_ADMIN] },
    "PUT",
    `/api/platform/tiers/${retiredTier}`,
    {
      displayName: "Student Old",
      rank: 13,
      includesAllFeatures: false,
      isActive: false,
      features: [],
      prices: [],
    },
  );
  teacherTier = await createTier({
    code: "teacher_basic_school",
    audience: "teacher",
    displayName: "Teacher Basic",
    rank: 11,
    features: [{ key: "auto_grading", monthlyLimit: 500 }],
  });
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
});

async function school(name: string, students: number) {
  const schoolId = (await createSchool(db.sql, { name })).id;
  const admin = await createUser(db.sql, schoolId);
  await assignRole(db.sql, schoolId, admin.id, "ORG_ADMIN");
  const created = [];
  for (let i = 0; i < students; i += 1) {
    created.push(
      await createStudent(db.sql, schoolId, { firstName: "Sch", lastName: `Student ${i}` }),
    );
  }
  const actor: LicenseActor = { kind: "school", userId: admin.id, homeSchoolId: schoolId };
  return {
    schoolId,
    adminId: admin.id,
    actor,
    students: created,
    as: (roles: string[] = [ROLES.ORG_ADMIN], userId = admin.id) => ({ schoolId, userId, roles }),
  };
}

async function activeLicense(schoolId: string, seats: number) {
  return change(schoolId, operator, async (tx) => {
    const license = await createLicense(
      tx,
      schoolId,
      {
        startsAt: new Date(Date.now() - 10 * DAY),
        endsAt: new Date(Date.now() + 200 * DAY),
        currencyCode: "USD",
        includeFamilyPlus: false,
        student: { planId: retiredTier, seats },
      },
      operator,
    );
    return transitionLicense(tx, schoolId, license.id, "active", operator);
  });
}

describe("people", () => {
  integrationTest(
    "lists everyone with their seat, eligibility and personal subscription end",
    async () => {
      const f = await school("People School", 3);
      const license = await activeLicense(f.schoolId, 2);
      const [seated, personal] = f.students;
      await change(f.schoolId, f.actor, (tx) =>
        assignSeats(
          tx,
          f.schoolId,
          license.id,
          { audience: "student", userIds: [seated!.userId] },
          f.actor,
        ),
      );
      const endsAt = new Date(Date.now() + 25 * DAY);
      await db.sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE studafy_admin");
        await tx`SELECT set_config('app.school_id', ${f.schoolId}, true)`;
        await tx`
          INSERT INTO app.ai_subscriptions (
            school_id, student_id, status, current_period_start, current_period_end
          ) VALUES (
            ${f.schoolId}::uuid, ${personal!.id}::uuid, 'active', now() - interval '5 days',
            ${endsAt}
          )
        `;
      });

      const list = async (query: string) => {
        const response = await request(f.as(), "GET", `/api/school/license/people${query}`);
        expect(response.status).toBe(200);
        return (await response.json()) as {
          show: string;
          total: number;
          people: {
            userId: string;
            eligible: boolean;
            seatId: string | null;
            assignedAt: string | null;
            hasPersonalSubscription: boolean;
            personalSubscriptionEndsAt: string | null;
          }[];
        };
      };

      const everyone = await list("?audience=student");
      expect(everyone.show).toBe("all");
      expect(everyone.total).toBe(3);
      const row = (userId: string) => everyone.people.find((p) => p.userId === userId)!;
      expect(row(seated!.userId)).toMatchObject({ eligible: true, hasPersonalSubscription: false });
      expect(row(seated!.userId).seatId).not.toBeNull();
      expect(row(seated!.userId).assignedAt).not.toBeNull();
      expect(row(personal!.userId)).toMatchObject({
        seatId: null,
        hasPersonalSubscription: true,
      });
      expect(Date.parse(row(personal!.userId).personalSubscriptionEndsAt!)).toBe(endsAt.getTime());

      const ids = async (query: string) => (await list(query)).people.map((p) => p.userId).sort();
      expect(await ids("?audience=student&show=seated")).toEqual([seated!.userId]);
      expect(await ids("?audience=student&show=unseated")).toEqual(
        [personal!.userId, f.students[2]!.userId].sort(),
      );
      expect(await ids("?audience=student&show=personal")).toEqual([personal!.userId]);
      expect((await list("?audience=student&show=personal")).show).toBe("personal");
      expect(await ids("?audience=student&search=Student%202")).toEqual([f.students[2]!.userId]);
      expect((await list("?audience=teacher")).people).toEqual([]);

      // No license: nobody, rather than an error.
      const bare = await school("People School Without License", 1);
      const none = await request(bare.as(), "GET", "/api/school/license/people?audience=student");
      expect(await none.json()).toMatchObject({ people: [], total: 0 });
    },
  );
});

describe("tiers", () => {
  integrationTest(
    "lists what each tier gives, with limits, active tiers and the license's own",
    async () => {
      const f = await school("Tier School", 0);
      const tiers = async () =>
        (
          (await (await request(f.as(), "GET", "/api/school/license/tiers")).json()) as {
            tiers: {
              id: string;
              isActive: boolean;
              includesAllFeatures: boolean;
              features: { key: string; monthlyLimit: number | null; unit: string | null }[];
            }[];
          }
        ).tiers;

      const before = await tiers();
      const plus = before.find((t) => t.id === plusTier)!;
      expect(plus.features).toEqual([
        expect.objectContaining({ key: "ai_tutor", monthlyLimit: 300, unit: "messages" }),
        expect.objectContaining({ key: "study_tools", monthlyLimit: null }),
      ]);
      // "Includes all" lists every student feature: its own limit where set, else the default.
      const pro = before.find((t) => t.id === proTier)!;
      expect(pro.features.map((x) => x.key)).toEqual(["ai_tutor", "study_tools", "notebook"]);
      expect(pro.features.find((x) => x.key === "ai_tutor")!.monthlyLimit).toBe(1000);
      expect(pro.features.find((x) => x.key === "notebook")!.monthlyLimit).toBe(50);
      expect(before.some((t) => t.id === teacherTier)).toBe(true);
      // A retired tier is not on offer...
      expect(before.some((t) => t.id === retiredTier)).toBe(false);
      // ...unless the school's license still uses it. No prices in either case.
      await activeLicense(f.schoolId, 5);
      const after = await tiers();
      expect(after.find((t) => t.id === retiredTier)).toMatchObject({ isActive: false });
      expect(JSON.stringify(after)).not.toContain("amountMinor");
    },
  );
});

describe("change requests", () => {
  integrationTest(
    "asks for a tier per audience; a tier of another audience is refused",
    async () => {
      const f = await school("Request School", 0);
      await activeLicense(f.schoolId, 5);

      const created = await request(f.as(), "POST", "/api/school/license/change-requests", {
        studentSeats: 40,
        studentPlanId: proTier,
        note: "Grade 9 wants the exam tools",
      });
      expect(created.status).toBe(201);
      expect(await created.json()).toMatchObject({
        studentSeats: 40,
        studentTier: { id: proTier, code: "student_pro_school", displayName: "Student Pro" },
        teacherTier: null,
        parentTier: null,
      });

      for (const body of [
        { studentPlanId: teacherTier, note: "Wrong audience" },
        { studentPlanId: retiredTier, note: "Retired" },
      ]) {
        const refused = await request(f.as(), "POST", "/api/school/license/change-requests", body);
        expect([body.note, refused.status]).toEqual([body.note, 422]);
      }

      // The database refuses a tier of the wrong audience whoever writes it.
      const direct = db.sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE studafy_admin");
        await tx`
        INSERT INTO app.license_change_requests (
          school_id, teacher_plan_id, note, requested_by
        ) VALUES (${f.schoolId}::uuid, ${plusTier}::uuid, 'direct', ${f.adminId}::uuid)
      `;
      });
      expect(direct).rejects.toThrow(/is not a teacher tier/);
      await direct.catch(() => undefined);

      const inbox = (await (
        await request(
          { schoolId: hq, userId: operator.userId, roles: [ROLES.SUPER_ADMIN] },
          "GET",
          "/api/platform/licenses/change-requests?status=open",
        )
      ).json()) as { requests: { schoolName: string; studentTier: { id: string } | null }[] };
      expect(inbox.requests.find((r) => r.schoolName === "Request School")?.studentTier?.id).toBe(
        proTier,
      );
    },
  );
});

describe("permissions", () => {
  integrationTest("license:read reads the new routes; an instructor cannot", async () => {
    const f = await school("Perm School", 0);
    const principal = await createUser(db.sql, f.schoolId);
    await assignRole(db.sql, f.schoolId, principal.id, "PRINCIPAL");
    const teacher = await createUser(db.sql, f.schoolId);
    await assignRole(db.sql, f.schoolId, teacher.id, "INSTRUCTOR");

    for (const path of [
      "/api/school/license/people?audience=student",
      "/api/school/license/tiers",
    ]) {
      const asPrincipal = await request(f.as([ROLES.PRINCIPAL], principal.id), "GET", path);
      expect([path, asPrincipal.status]).toEqual([path, 200]);
      const asTeacher = await request(f.as([ROLES.INSTRUCTOR], teacher.id), "GET", path);
      expect([path, asTeacher.status]).toEqual([path, 403]);
    }
  });
});
