/**
 * Student AI opt-in notices (000235/000239) against a real database: parents of eligible children are
 * told once per child and window, nobody outside the window's sections or already opted in, nothing
 * from a closed window; leadership's daily summary counts each new opt-in once. Needs
 * TEST_DATABASE_URL pointing at a fully migrated database, like the other billing job tests.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { runAiOptInNotices } from "../ai-optin-notices";

import type { Sql, TransactionSql } from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled = Boolean(databaseUrl);
const jobTest = test.skipIf(!enabled);

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const VERSION = "a1000000-0000-4000-8000-000000000001";

let db: Sql | undefined;
let usd = "";
let jo = "";
let tier = "";

beforeAll(async () => {
  if (!enabled) return;
  db = postgres(databaseUrl!, { max: 4, ssl: false, prepare: false });
  const [ref] = await db<{ usd: string; jo: string }[]>`
    SELECT (SELECT id::text FROM app.currencies WHERE code = 'USD') AS usd,
           (SELECT id::text FROM app.countries WHERE alpha2_code = 'JO') AS jo
  `;
  usd = ref!.usd;
  jo = ref!.jo;
  await admin(null, async (tx) => {
    const [plan] = await tx<{ id: string }[]>`
      INSERT INTO app.plans (code, display_name, audience, rank)
      VALUES (${`student_optin_${crypto.randomUUID().slice(0, 8)}`}, 'Student Opt-in', 'student',
              ${100 + Math.floor(Math.random() * 30_000)})
      RETURNING id::text AS id
    `;
    tier = plan!.id;
  });
});

afterAll(async () => {
  await db?.end({ timeout: 5 });
});

async function admin<T>(
  schoolId: string | null,
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  await db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    if (schoolId) await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    result = await fn(tx);
  });
  return result as T;
}

async function user(schoolId: string, role: string): Promise<string> {
  return admin(schoolId, async (tx) => {
    const email = `${crypto.randomUUID().slice(0, 8)}@optin.local`;
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
      VALUES (${schoolId}::uuid, ${email}, ${email}, 'Opt-in User', 'active')
      RETURNING id::text AS id
    `;
    await tx`
      INSERT INTO app.user_roles (school_id, user_id, role)
      VALUES (${schoolId}::uuid, ${row!.id}::uuid, ${role}::app.user_role)
    `;
    return row!.id;
  });
}

interface World {
  schoolId: string;
  adminId: string;
  licenseId: string;
  yearId: string;
  sectionA: string;
  sectionB: string;
}

/** A school with an active licence, a running academic year and two sections. */
async function world(): Promise<World> {
  const slug = `optin-${crypto.randomUUID().slice(0, 8)}`;
  const schoolId = await admin(null, async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
      VALUES (${slug}, 'Opt-in School', ${`${slug}@admin.local`}, ${`${slug}@admin.local`},
              ${jo}::uuid, ${usd}::uuid)
      RETURNING id::text AS id
    `;
    return row!.id;
  });
  const adminId = await user(schoolId, "ORG_ADMIN");
  return admin(schoolId, async (tx) => {
    const [license] = await tx<{ id: string }[]>`
      INSERT INTO app.school_licenses (
        school_id, status, starts_at, ends_at, student_plan_id, student_seats, currency_id,
        created_by, activated_at, ai_programme_version_id
      ) VALUES (
        ${schoolId}::uuid, 'active', now() - interval '30 days', now() + interval '300 days',
        ${tier}::uuid, 10, ${usd}::uuid, ${adminId}::uuid, now(), ${VERSION}::uuid
      )
      RETURNING id::text AS id
    `;
    const [year] = await tx<{ id: string }[]>`
      INSERT INTO app.academic_years (school_id, code, name, starts_on, ends_on, status)
      VALUES (${schoolId}::uuid, 'AY', 'This year', current_date - 60, current_date + 200, 'active')
      RETURNING id::text AS id
    `;
    const [grade] = await tx<{ id: string }[]>`
      INSERT INTO app.grade_levels (school_id, name, sort_order)
      VALUES (${schoolId}::uuid, 'Grade 5', 5) RETURNING id::text AS id
    `;
    const sections = await tx<{ id: string }[]>`
      INSERT INTO app.sections (school_id, academic_year_id, grade_level_id, name)
      VALUES (${schoolId}::uuid, ${year!.id}::uuid, ${grade!.id}::uuid, 'A'),
             (${schoolId}::uuid, ${year!.id}::uuid, ${grade!.id}::uuid, 'B')
      RETURNING id::text AS id
    `;
    return {
      schoolId,
      adminId,
      licenseId: license!.id,
      yearId: year!.id,
      sectionA: sections[0]!.id,
      sectionB: sections[1]!.id,
    };
  });
}

/** An enrolled child in `sectionId` with one linked parent. */
async function child(w: World, sectionId: string) {
  const studentUser = await user(w.schoolId, "STUDENT");
  const parentId = await user(w.schoolId, "PARENT");
  const studentId = await admin(w.schoolId, async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO app.students (school_id, user_id, admission_number, first_name, last_name, status)
      VALUES (${w.schoolId}::uuid, ${studentUser}::uuid, ${`ADM-${crypto.randomUUID().slice(0, 8)}`},
              'Amina', 'Tazi', 'enrolled')
      RETURNING id::text AS id
    `;
    await tx`
      INSERT INTO app.student_sections (school_id, student_id, academic_year_id, section_id)
      VALUES (${w.schoolId}::uuid, ${row!.id}::uuid, ${w.yearId}::uuid, ${sectionId}::uuid)
    `;
    const [family] = await tx<{ id: string }[]>`
      INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
      VALUES (${w.schoolId}::uuid, 'Tazi family', ${parentId}::uuid)
      RETURNING id::text AS id
    `;
    await tx`
      INSERT INTO app.parent_child_links (
        school_id, parent_user_id, student_id, relationship, family_id
      ) VALUES (
        ${w.schoolId}::uuid, ${parentId}::uuid, ${row!.id}::uuid, 'mother', ${family!.id}::uuid
      )
    `;
    return row!.id;
  });
  return { studentId, parentId };
}

async function openWindow(w: World, sectionIds: string[] = []): Promise<string> {
  return admin(w.schoolId, async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO app.ai_optin_windows (
        school_id, license_id, academic_year_id, opens_on, closes_on, opened_by
      ) VALUES (
        ${w.schoolId}::uuid, ${w.licenseId}::uuid, ${w.yearId}::uuid, current_date - 1,
        current_date + 14, ${w.adminId}::uuid
      )
      RETURNING id::text AS id
    `;
    for (const sectionId of sectionIds) {
      await tx`
        INSERT INTO app.ai_optin_window_scopes (school_id, window_id, section_id)
        VALUES (${w.schoolId}::uuid, ${row!.id}::uuid, ${sectionId}::uuid)
      `;
    }
    return row!.id;
  });
}

async function optIn(w: World, studentId: string, parentId: string, windowId: string) {
  await admin(
    w.schoolId,
    (tx) => tx`
      INSERT INTO app.ai_optins (
        school_id, student_id, academic_year_id, license_id, window_id, source, parent_user_id,
        recorded_by, terms_version, start_month, end_month, months, currency_id,
        monthly_price_minor, total_minor
      ) VALUES (
        ${w.schoolId}::uuid, ${studentId}::uuid, ${w.yearId}::uuid, ${w.licenseId}::uuid,
        ${windowId}::uuid, 'parent', ${parentId}::uuid, ${parentId}::uuid, '2026-11-17',
        date_trunc('month', current_date)::date, date_trunc('month', current_date)::date, 1,
        ${usd}::uuid, 600, 600
      )
    `,
  );
}

async function notices(w: World, userId: string, type: string) {
  return admin(
    w.schoolId,
    (tx) => tx<{ title: string; body: string; metadata: Record<string, string> }[]>`
      SELECT title, body, metadata FROM app.notifications
      WHERE school_id = ${w.schoolId}::uuid AND user_id = ${userId}::uuid
        AND notification_type = ${type}::app.notification_type
    `,
  );
}

describe("Student AI available", () => {
  jobTest("tells each eligible child's parent once, with the price parents see", async () => {
    const w = await world();
    const a = await child(w, w.sectionA);
    const windowId = await openWindow(w);

    const first = await runAiOptInNotices(db!, new Date(), silentLogger, {
      schoolIds: [w.schoolId],
      summary: false,
    });
    expect(first.children).toBe(1);
    const sent = await notices(w, a.parentId, "AI_OPTIN_AVAILABLE");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toBe("Student AI is available for Amina Tazi");
    expect(sent[0]!.title).toContain("6.00 USD");
    expect(sent[0]!.metadata).toMatchObject({
      route: "/parent/student-ai",
      student_id: a.studentId,
      window_id: windowId,
    });

    // A re-run sends nothing twice.
    await runAiOptInNotices(db!, new Date(), silentLogger, {
      schoolIds: [w.schoolId],
      summary: false,
    });
    expect(await notices(w, a.parentId, "AI_OPTIN_AVAILABLE")).toHaveLength(1);
  });

  jobTest(
    "skips children outside the window's sections and children already opted in",
    async () => {
      const w = await world();
      const inside = await child(w, w.sectionA);
      const outside = await child(w, w.sectionB);
      const opted = await child(w, w.sectionA);
      const windowId = await openWindow(w, [w.sectionA]);
      await optIn(w, opted.studentId, opted.parentId, windowId);

      await runAiOptInNotices(db!, new Date(), silentLogger, {
        schoolIds: [w.schoolId],
        summary: false,
      });
      expect(await notices(w, inside.parentId, "AI_OPTIN_AVAILABLE")).toHaveLength(1);
      expect(await notices(w, outside.parentId, "AI_OPTIN_AVAILABLE")).toHaveLength(0);
      expect(await notices(w, opted.parentId, "AI_OPTIN_AVAILABLE")).toHaveLength(0);
    },
  );

  jobTest("a closed window tells nobody", async () => {
    const w = await world();
    const a = await child(w, w.sectionA);
    const windowId = await openWindow(w);
    await admin(
      w.schoolId,
      (tx) => tx`
        UPDATE app.ai_optin_windows SET closed_at = now(), closed_by = ${w.adminId}::uuid
        WHERE id = ${windowId}::uuid
      `,
    );
    await runAiOptInNotices(db!, new Date(), silentLogger, {
      schoolIds: [w.schoolId],
      summary: false,
    });
    expect(await notices(w, a.parentId, "AI_OPTIN_AVAILABLE")).toHaveLength(0);
  });
});

describe("leadership's daily summary", () => {
  jobTest("counts each new opt-in once, with those waiting for a seat", async () => {
    const w = await world();
    const windowId = await openWindow(w);
    const a = await child(w, w.sectionA);
    const b = await child(w, w.sectionB);
    await optIn(w, a.studentId, a.parentId, windowId);
    await optIn(w, b.studentId, b.parentId, windowId);

    // Not the summary hour: nothing for leadership.
    await runAiOptInNotices(db!, new Date(), silentLogger, {
      schoolIds: [w.schoolId],
      summary: false,
    });
    expect(await notices(w, w.adminId, "AI_OPTIN_SUMMARY")).toHaveLength(0);

    const run = await runAiOptInNotices(db!, new Date(), silentLogger, {
      schoolIds: [w.schoolId],
      summary: true,
    });
    expect(run.summaries).toBe(1);
    const sent = await notices(w, w.adminId, "AI_OPTIN_SUMMARY");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toBe("2 new Student AI opt-ins");
    expect(sent[0]!.title).toBe("2 students opted in · 2 waiting for a seat");

    // The next day's run has nothing new.
    await runAiOptInNotices(db!, new Date(), silentLogger, {
      schoolIds: [w.schoolId],
      summary: true,
    });
    expect(await notices(w, w.adminId, "AI_OPTIN_SUMMARY")).toHaveLength(1);
  });
});
