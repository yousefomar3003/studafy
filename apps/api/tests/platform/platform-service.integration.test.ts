// Studafy platform console service against a real, migrated database.
//
// The service walks schools one tenant scope at a time under studafy_admin, because tenant RLS is
// FORCEd onto that role too (ADR-0015). These tests prove the walk sees each school's own rows and
// only those, that a lifecycle change writes both audit rows, and that the mutations respect their
// guards -- none of which a mocked transaction can show.

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  changeSchoolStatus,
  getPlatformOverview,
  getSchoolDetail,
  listPlans,
  listSchoolMembers,
  listSchools,
  lookupUserByEmail,
  setSchoolFeatureFlag,
  updatePlan,
  updatePlanPrice,
  updatePlatformSetting,
} from "../../src/modules/platform/service";
import {
  assignRole,
  createSchool,
  createStudent,
  createTeacher,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
  type TestDatabase,
} from "../harness";

import type { Database } from "../../src/db/client";
import type { Actor } from "../../src/modules/platform/service";

const integrationTest = test.skipIf(!integrationEnabled);

interface Fixture {
  home: string;
  alpha: string;
  beta: string;
  actor: Actor;
  planId: string;
  priceId: string;
  sharedEmail: string;
}

let db: TestDatabase;
let fixture: Fixture;

async function seed(sql: TestDatabase["sql"]): Promise<Fixture> {
  const home = (await createSchool(sql, { name: "Studafy HQ" })).id;
  const alpha = (await createSchool(sql, { name: "Alpha Academy" })).id;
  const beta = (await createSchool(sql, { name: "Beta School" })).id;

  const operator = await createUser(sql, home, { email: "ops@studafy.test" });
  await assignRole(sql, home, operator.id, "SUPER_ADMIN");

  // Alpha: two students and an admin, all active. Beta: one student, one invited teacher.
  for (const email of ["s1@alpha.test", "s2@alpha.test"]) {
    const student = await createUser(sql, alpha, { email });
    await assignRole(sql, alpha, student.id, "STUDENT");
  }
  const sharedEmail = "same.person@example.test";
  const alphaAdmin = await createUser(sql, alpha, { email: sharedEmail });
  await assignRole(sql, alpha, alphaAdmin.id, "ORG_ADMIN");
  const betaStudent = await createUser(sql, beta, { email: "s1@beta.test" });
  await assignRole(sql, beta, betaStudent.id, "STUDENT");
  const betaTeacher = await createUser(sql, beta, { email: sharedEmail, status: "invited" });
  await assignRole(sql, beta, betaTeacher.id, "INSTRUCTOR");

  let planId = "";
  let priceId = "";
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    const [plan] = await tx<{ id: string }[]>`
      INSERT INTO app.plans (code, display_name, is_active)
      VALUES ('platform_test_plan', 'Platform Test Plan', true) RETURNING id
    `;
    planId = plan!.id;
    const [price] = await tx<{ id: string }[]>`
      INSERT INTO app.plan_prices (plan_id, currency_id, billing_interval, amount_minor)
      VALUES (${planId}, (SELECT id FROM app.currencies WHERE code = 'USD'), 'monthly', 1999)
      RETURNING id
    `;
    priceId = price!.id;

    await tx`SELECT set_config('app.school_id', ${alpha}, true)`;
    await tx`
      INSERT INTO app.subscriptions (school_id, plan_id, status, current_period_start,
                                     current_period_end, student_cap, trial_expires_at)
      VALUES (${alpha}, ${planId}, 'trialing', CURRENT_TIMESTAMP,
              CURRENT_TIMESTAMP + INTERVAL '30 days', 100, CURRENT_TIMESTAMP + INTERVAL '3 days')
    `;
    await tx`UPDATE app.schools SET status = 'active' WHERE id IN (${home}, ${alpha})`;

    await tx`
      INSERT INTO app.platform_settings (key, description, value_type, integer_value, is_mutable)
      VALUES ('platform.test_limit', 'Test limit', 'integer', 10, true),
             ('platform.frozen', 'Frozen value', 'integer', 1, false)
    `;
  });

  return {
    home,
    alpha,
    beta,
    actor: { userId: operator.id, schoolId: home },
    planId,
    priceId,
    sharedEmail,
  };
}

async function auditRows(schoolId: string, table: string) {
  return db.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    return tx<{ actor_id: string | null; old_values: unknown; new_values: unknown }[]>`
      SELECT actor_id, old_values, new_values FROM app.audit_logs
      WHERE target_table = ${table} ORDER BY created_at
    `;
  });
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

describe("platform console reads", () => {
  integrationTest("the overview counts every school's own rows", async () => {
    const overview = await getPlatformOverview(database());
    expect(overview.totalSchools).toBe(3);
    expect(overview.schoolsByStatus).toEqual({
      registered: 0,
      pending: 1,
      active: 2,
      suspended: 0,
      archived: 0,
    });
    // ops + 3 in alpha + 1 active student in beta (the invited teacher is not active).
    expect(overview.totalActiveUsers).toBe(5);
    expect(overview.totalStudents).toBe(3);
    expect(overview.subscriptionsByStatus).toEqual({ trialing: 1 });
    expect(overview.subscriptionsByPlan).toEqual({ platform_test_plan: 1 });
    expect(overview.trialsEndingIn7Days).toBe(1);
  });

  integrationTest("the school list filters, searches and attaches per-school figures", async () => {
    const all = await listSchools(database(), { limit: 25, offset: 0 });
    expect(all.total).toBe(3);

    const found = await listSchools(database(), { search: "alpha", limit: 25, offset: 0 });
    expect(found.total).toBe(1);
    const alpha = found.schools[0]!;
    expect(alpha.name).toBe("Alpha Academy");
    expect(alpha.students).toBe(2);
    expect(alpha.subscription?.planCode).toBe("platform_test_plan");

    const pending = await listSchools(database(), { status: "pending", limit: 25, offset: 0 });
    expect(pending.schools.map((s) => s.id)).toEqual([fixture.beta]);
    expect(pending.schools[0]!.subscription).toBeNull();
  });

  integrationTest("school detail counts roles within that school only", async () => {
    const detail = await getSchoolDetail(database(), fixture.beta);
    expect(detail.roleCounts).toEqual({ STUDENT: 1, INSTRUCTOR: 1 });
    expect(detail.allowedTransitions).toEqual(["active", "archived"]);
    expect(detail.featureFlags.every((flag) => flag.override === null)).toBe(true);
  });

  integrationTest("a user lookup finds one person's accounts across schools", async () => {
    const matches = await lookupUserByEmail(database(), fixture.sharedEmail.toUpperCase());
    expect(matches.map((m) => [m.schoolId, m.roles]).sort()).toEqual(
      [
        [fixture.alpha, ["ORG_ADMIN"]],
        [fixture.beta, ["INSTRUCTOR"]],
      ].sort(),
    );
  });

  integrationTest("an unknown school is a 404", async () => {
    await expect(
      getSchoolDetail(database(), "00000000-0000-4000-8000-0000000000ff"),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("platform console writes", () => {
  integrationTest(
    "suspending a school writes a system row there and an operator row at home",
    async () => {
      const change = await changeSchoolStatus(
        database(),
        fixture.alpha,
        "suspended",
        "Unpaid invoices",
        fixture.actor,
      );
      expect(change).toEqual({ from: "active", to: "suspended", aiEffect: "pause" });

      const inSchool = await auditRows(fixture.alpha, "schools");
      expect(inSchool).toHaveLength(1);
      expect(inSchool[0]!.actor_id).toBeNull();
      expect(inSchool[0]!.new_values).toMatchObject({
        status: "suspended",
        reason: "Unpaid invoices",
      });

      const atHome = await auditRows(fixture.home, "schools");
      expect(atHome.at(-1)!.actor_id).toBe(fixture.actor.userId);

      // Re-sending the current status is a retry: no row change, no new audit, replayed effect.
      const retry = await changeSchoolStatus(
        database(),
        fixture.alpha,
        "suspended",
        "Retry billing",
        fixture.actor,
      );
      expect(retry.aiEffect).toBe("pause");
      expect(await auditRows(fixture.alpha, "schools")).toHaveLength(1);
    },
  );

  integrationTest("an illegal transition is refused with 409", async () => {
    await expect(
      changeSchoolStatus(database(), fixture.beta, "suspended", "Not yet live", fixture.actor),
    ).rejects.toMatchObject({ status: 409 });
  });

  integrationTest("a feature flag override is set, audited, then cleared", async () => {
    const pinned = await setSchoolFeatureFlag(
      database(),
      null,
      fixture.beta,
      "ai.llm",
      true,
      fixture.actor,
    );
    expect(pinned.featureFlags.find((f) => f.name === "ai.llm")!.override).toBe(true);

    // Alpha's flags are untouched: the override is scoped to beta.
    const alpha = await getSchoolDetail(database(), fixture.alpha);
    expect(alpha.featureFlags.find((f) => f.name === "ai.llm")!.override).toBeNull();

    const cleared = await setSchoolFeatureFlag(
      database(),
      null,
      fixture.beta,
      "ai.llm",
      null,
      fixture.actor,
    );
    expect(cleared.featureFlags.find((f) => f.name === "ai.llm")!.override).toBeNull();
    expect(await auditRows(fixture.beta, "feature_flags")).toHaveLength(2);
  });

  integrationTest("plans and prices update and are audited at home", async () => {
    const plan = await updatePlan(
      database(),
      fixture.planId,
      { displayName: "Renamed Plan", isActive: false },
      fixture.actor,
    );
    expect(plan.displayName).toBe("Renamed Plan");
    expect(plan.isActive).toBe(false);

    const withPrice = await updatePlanPrice(
      database(),
      fixture.planId,
      fixture.priceId,
      false,
      fixture.actor,
    );
    expect(withPrice.prices[0]!.isActive).toBe(false);

    const plans = await listPlans(database());
    expect(plans.find((p) => p.id === fixture.planId)!.prices[0]!.amountMinor).toBe(1999);
    expect(await auditRows(fixture.home, "plans")).toHaveLength(1);
    expect(await auditRows(fixture.home, "plan_prices")).toHaveLength(1);
  });

  integrationTest("only mutable settings change, and only to their own type", async () => {
    const updated = await updatePlatformSetting(
      database(),
      "platform.test_limit",
      25,
      fixture.actor,
    );
    expect(updated.value).toBe(25);

    await expect(
      updatePlatformSetting(database(), "platform.test_limit", "lots", fixture.actor),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      updatePlatformSetting(database(), "platform.frozen", 2, fixture.actor),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe("platform school members", () => {
  // Seeded here, after the overview and list assertions above have run, so the extra school and
  // accounts do not shift their totals.
  let gamma = "";
  let studentUserId = "";
  let parentUserId = "";

  beforeAll(async () => {
    if (!integrationEnabled) return;
    gamma = (await createSchool(db.sql, { name: "Gamma College" })).id;
    const student = await createStudent(db.sql, gamma, {
      firstName: "Sara",
      lastName: "Ali",
      admissionNumber: "G-001",
    });
    studentUserId = student.userId;
    await assignRole(db.sql, gamma, student.userId, "STUDENT");
    const parent = await createUser(db.sql, gamma, {
      email: "huda@gamma.test",
      displayName: "Huda Ali",
      status: "invited",
    });
    parentUserId = parent.id;
    await assignRole(db.sql, gamma, parent.id, "PARENT");
    const teacher = await createTeacher(db.sql, gamma, { employeeNumber: "EMP-77" });
    await assignRole(db.sql, gamma, teacher.userId, "INSTRUCTOR");

    await db.sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE studafy_admin");
      await tx`SELECT set_config('app.school_id', ${gamma}, true)`;
      const [family] = await tx<{ id: string }[]>`
        INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
        VALUES (${gamma}, 'Ali', ${parent.id}) RETURNING id
      `;
      await tx`
        INSERT INTO app.parent_child_links (school_id, parent_user_id, student_id, relationship,
                                            family_id)
        VALUES (${gamma}, ${parent.id}, ${student.id}, 'mother', ${family!.id})
      `;
    });
  });

  integrationTest("lists one school's accounts with role-specific records", async () => {
    const page = await listSchoolMembers(
      database(),
      gamma,
      { limit: 25, offset: 0 },
      fixture.actor,
    );
    expect(page.total).toBe(3);
    expect(page.memberCount).toBe(3);
    expect(page.roleCounts).toEqual({ STUDENT: 1, PARENT: 1, INSTRUCTOR: 1 });

    const student = page.members.find((m) => m.userId === studentUserId)!;
    expect(student.displayName).toBe("Sara Ali");
    expect(student.student).toMatchObject({ admissionNumber: "G-001", classes: [] });
    expect(student.student!.guardians).toEqual([
      { userId: parentUserId, displayName: "Huda Ali", relationship: "mother" },
    ]);

    const parent = page.members.find((m) => m.userId === parentUserId)!;
    expect(parent.status).toBe("invited");
    expect(parent.children).toMatchObject([{ name: "Sara Ali", admissionNumber: "G-001" }]);

    const teacher = page.members.find((m) => m.roles.includes("INSTRUCTOR"))!;
    expect(teacher.teacher?.employeeNumber).toBe("EMP-77");
  });

  integrationTest("filters by role, status and search", async () => {
    const actor = fixture.actor;
    const parents = await listSchoolMembers(
      database(),
      gamma,
      { role: "PARENT", limit: 25, offset: 0 },
      actor,
    );
    expect(parents.members.map((m) => m.userId)).toEqual([parentUserId]);
    // Counts stay unfiltered, for the chips.
    expect(parents.memberCount).toBe(3);

    const invited = await listSchoolMembers(
      database(),
      gamma,
      { status: "invited", limit: 25, offset: 0 },
      actor,
    );
    expect(invited.total).toBe(1);

    const byAdmission = await listSchoolMembers(
      database(),
      gamma,
      { search: "g-001", limit: 25, offset: 0 },
      actor,
    );
    expect(byAdmission.members.map((m) => m.userId)).toEqual([studentUserId]);
  });

  integrationTest("never returns another school's accounts", async () => {
    const page = await listSchoolMembers(
      database(),
      fixture.beta,
      { limit: 25, offset: 0 },
      fixture.actor,
    );
    // Beta's own student and invited teacher, nothing of gamma's.
    expect(page.total).toBe(2);
    expect(page.members.some((m) => m.userId === studentUserId)).toBe(false);
  });

  integrationTest("a roster read is audited in the school and at home", async () => {
    const inSchool = await auditRows(gamma, "users");
    expect(inSchool.length).toBeGreaterThan(0);
    expect(inSchool.every((row) => row.actor_id === null)).toBe(true);
    const atHome = await auditRows(fixture.home, "users");
    expect(atHome.at(-1)!.actor_id).toBe(fixture.actor.userId);
  });

  integrationTest("an unknown school is a 404", async () => {
    await expect(
      listSchoolMembers(
        database(),
        "00000000-0000-4000-8000-0000000000ff",
        { limit: 25, offset: 0 },
        fixture.actor,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});
