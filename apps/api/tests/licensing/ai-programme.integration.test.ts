/**
 * The Student AI programme's settings against a real database (migration 000234): the seeded
 * defaults; global versions saved, validated, immutable and audited; per-school overrides and what
 * a school resolves to; quotes and licences keeping the values they were signed with, and the super
 * admin re-applying the current ones; the licence's grace period driving the AI stop date; tenant
 * isolation of the override tables; and the routes' permissions.
 *
 * The tests in this file share one database and run in order: later ones build on the global
 * versions earlier ones saved, and read "the current version" rather than assume its number.
 */

import { ROLES } from "@studafy/constants";
import { DEFAULT_AI_PROGRAMME_SETTINGS } from "@studafy/license-pricing";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createLogger } from "../../src/logger";
import { AUTH_CHANNELS } from "../../src/modules/auth/channels";
import {
  INITIAL_AI_PROGRAMME_VERSION_ID,
  acceptQuote,
  clearSchoolOverride,
  createLicense,
  createQuote,
  currentAiProgrammeVersion,
  licenseAiProgramme,
  reapplyAiProgramme,
  runLicenseChange,
  saveAiProgrammeVersion,
  saveSchoolOverride,
  schoolAiProgramme,
  sendQuote,
} from "../../src/modules/licensing";
import {
  listAiProgrammeOverrides,
  listAiProgrammeVersions,
  previewSchoolOverride,
} from "../../src/modules/licensing/ai-programme";
import { requireInvoiceDetail } from "../../src/modules/licensing/invoices";
import { readLicense } from "../../src/modules/licensing/service";
import {
  assignRole,
  authenticatedRequest,
  createSchool,
  createTestApp,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import type { LicenseActor, LicensingDeps, QuoteTerms } from "../../src/modules/licensing";
import type { SchoolOverrideInput } from "../../src/modules/licensing/ai-programme";
import type { TestApp, TestDatabase } from "../harness";
import type { AiProgrammeSettings } from "@studafy/license-pricing";
import type { TransactionSql } from "postgres";

const integrationTest = test.skipIf(!integrationEnabled);
const logger = createLogger({ destination: () => undefined });

let db: TestDatabase;
let hq: string;
let operator: LicenseActor;
let studentTier = "";

function deps(): LicensingDeps {
  return {
    database: db.sql,
    redis: null,
    logger,
    providers: { stripe: null, googlePlay: null },
    storage: null,
  };
}

async function asAdmin<T>(
  schoolId: string | null,
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  await db.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId ?? ""}, true)`;
    result = await fn(tx);
  });
  return result as T;
}

async function asApp<T>(schoolId: string, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  let result: T | undefined;
  await db.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_app");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    result = await fn(tx);
  });
  return result as T;
}

/** A change in a school as `actor`, through the flow the routes use. */
function as<T>(
  schoolId: string,
  actor: LicenseActor,
  fn: (tx: TransactionSql) => Promise<{ result: T; versions?: Map<string, number>; pending?: [] }>,
) {
  return runLicenseChange(deps(), schoolId, actor, async (tx) => {
    const changed = await fn(tx);
    return {
      result: changed.result,
      versions: changed.versions ?? new Map(),
      pending: changed.pending ?? [],
    };
  }).then((r) => r.result);
}

const inSchool = <T>(schoolId: string, fn: (tx: TransactionSql) => Promise<T>) =>
  as(schoolId, operator, async (tx) => ({ result: await fn(tx) }));

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
  return "no refusal";
}

/** The settings in force, changed by `patch`, as a save request. */
async function nextVersion(patch: Partial<AiProgrammeSettings>, reason = "Test change") {
  const current = await asAdmin(null, currentAiProgrammeVersion);
  return { ...current.settings, ...patch, reason, basedOnVersionId: current.id };
}

const EMPTY_FIELDS: Omit<SchoolOverrideInput, "reason"> = {
  licensePriceMinor: null,
  parentPriceMinor: null,
  minSeats: null,
  maxShareBps: null,
  conversionTiers: null,
  largeSchoolMinSeats: null,
  largeSchoolShareBps: null,
  contentBonusTiers: null,
  bonusRequiresConversionShare: null,
  measurementOffsetDays: null,
  nonpaymentGraceDays: null,
  monthToMonthShareBps: null,
  payoutMode: null,
};

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createTestDatabase({ maxConnections: 8 });
  await migrateDatabase(db.url);

  hq = (await createSchool(db.sql, { name: "Studafy HQ" })).id;
  const op = await createUser(db.sql, hq, {
    email: "programme-ops@studafy.test",
    displayName: "Programme Operator",
  });
  await assignRole(db.sql, hq, op.id, "SUPER_ADMIN");
  operator = { kind: "platform", userId: op.id, homeSchoolId: hq };

  await asAdmin(null, async (tx) => {
    const [student] = await tx<{ id: string }[]>`
      INSERT INTO app.plans (code, display_name, audience, rank)
      VALUES ('student_ai_programme', 'Student AI', 'student', 2) RETURNING id::text AS id
    `;
    await tx`
      INSERT INTO app.plan_prices (plan_id, currency_id, billing_interval, amount_minor)
      SELECT ${student!.id}::uuid, id, 'monthly'::app.billing_interval, 400
      FROM app.currencies WHERE code = 'USD'
    `;
    studentTier = student!.id;
  });
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
});

async function school(name = "Programme School") {
  const schoolId = (await createSchool(db.sql, { name })).id;
  const admin = await createUser(db.sql, schoolId);
  await assignRole(db.sql, schoolId, admin.id, "ORG_ADMIN");
  return {
    schoolId,
    admin: { kind: "school", userId: admin.id, homeSchoolId: schoolId } as LicenseActor,
  };
}

const newTerm = (seats: number): QuoteTerms => ({
  kind: "new",
  currencyCode: "USD",
  months: 10,
  student: { planId: studentTier, seats },
});

// ---------------------------------------------------------------------------------------------------
// Global versions
// ---------------------------------------------------------------------------------------------------

describe("global versions", () => {
  integrationTest("the migration seeds the approved defaults as version 1", async () => {
    const current = await asAdmin(null, currentAiProgrammeVersion);
    expect(current.id).toBe(INITIAL_AI_PROGRAMME_VERSION_ID);
    expect(current.versionNumber).toBe(1);
    expect(current.settings).toEqual(DEFAULT_AI_PROGRAMME_SETTINGS as typeof current.settings);
    // The owner's prices (2026-11-18): in-app $5.99 (reference), school-offer $4, licence $4.
    expect(current.settings.prices).toEqual([
      { currencyCode: "USD", iapPriceMinor: 599, licensePriceMinor: 400, parentPriceMinor: 400 },
    ]);
    expect(current.createdBy).toEqual({ userId: null, name: null });
  });

  integrationTest(
    "a save is a new version with who, when and why, audited in the operator's school",
    async () => {
      const before = await asAdmin(null, currentAiProgrammeVersion);
      // Parents at exactly the licence price: the school keeps no margin, and that is allowed.
      const saved = await asAdmin(null, async (tx) =>
        saveAiProgrammeVersion(
          tx,
          await nextVersion(
            {
              prices: [
                {
                  currencyCode: "USD",
                  iapPriceMinor: 600,
                  licensePriceMinor: 400,
                  parentPriceMinor: 400,
                },
              ],
            },
            "  Parents pay the licence price  ",
          ),
          operator,
        ),
      );
      expect(saved.versionNumber).toBe(before.versionNumber + 1);
      expect(saved.reason).toBe("Parents pay the licence price");
      expect(saved.createdBy.userId).toBe(operator.userId);
      expect(saved.settings.prices[0]!.parentPriceMinor).toBe(400);
      // The earlier version is still there, unchanged.
      const versions = await asAdmin(null, listAiProgrammeVersions);
      expect(versions[0]!.id).toBe(saved.id);
      expect(versions.find((v) => v.id === before.id)!.settings).toEqual(before.settings);

      const [audit] = await asAdmin(
        hq,
        (tx) => tx<{ actor_id: string; new_values: { reason: string } }[]>`
          SELECT actor_id::text AS actor_id, new_values FROM app.audit_logs
          WHERE school_id = ${hq}::uuid AND target_table = 'ai_programme_versions'
            AND target_id = ${saved.id}::uuid
        `,
      );
      expect(audit).toMatchObject({
        actor_id: operator.userId,
        new_values: { reason: "Parents pay the licence price" },
      });

      // Parents below the licence price are allowed too.
      const below = await asAdmin(null, async (tx) =>
        saveAiProgrammeVersion(
          tx,
          await nextVersion({
            prices: [
              {
                currencyCode: "USD",
                iapPriceMinor: 600,
                licensePriceMinor: 400,
                parentPriceMinor: 300,
              },
            ],
          }),
          operator,
        ),
      );
      expect(below.settings.prices[0]!.parentPriceMinor).toBe(300);
    },
  );

  integrationTest("invalid settings are refused with their own codes", async () => {
    const save = async (patch: Partial<AiProgrammeSettings>, reason = "Test change") =>
      refusal(
        asAdmin(null, async (tx) =>
          saveAiProgrammeVersion(tx, await nextVersion(patch, reason), operator),
        ),
      );
    expect(
      await save({
        conversionTiers: [
          { fromBps: 0, shareBps: 0 },
          { fromBps: 4000, shareBps: 600 },
          { fromBps: 2500, shareBps: 400 },
        ],
      }),
    ).toBe("AI_PROGRAMME_TIERS_INVALID");
    expect(await save({ largeSchoolShareBps: 2000 })).toBe("AI_PROGRAMME_SHARE_ABOVE_MAX");
    expect(await save({ maxShareBps: 10_001 })).toBe("AI_PROGRAMME_VALUE_OUT_OF_RANGE");
    expect(await save({ nonpaymentGraceDays: 0 })).toBe("AI_PROGRAMME_VALUE_OUT_OF_RANGE");
    expect(
      await save({
        prices: [
          { currencyCode: "USD", iapPriceMinor: -1, licensePriceMinor: 0, parentPriceMinor: 0 },
        ],
      }),
    ).toBe("AI_PROGRAMME_VALUE_OUT_OF_RANGE");
    expect(
      await save({
        prices: [
          { currencyCode: "ZZZ", iapPriceMinor: 1, licensePriceMinor: 1, parentPriceMinor: 1 },
        ],
      }),
    ).toBe("AI_PROGRAMME_CURRENCY_INVALID");
    expect(await save({}, "   ")).toBe("AI_PROGRAMME_REASON_REQUIRED");
  });

  integrationTest("a save based on an older version is a conflict", async () => {
    const stale = await nextVersion({ minSeats: 31 });
    await asAdmin(null, async (tx) =>
      saveAiProgrammeVersion(tx, await nextVersion({ minSeats: 32 }), operator),
    );
    expect(await refusal(asAdmin(null, (tx) => saveAiProgrammeVersion(tx, stale, operator)))).toBe(
      "AI_PROGRAMME_VERSION_CONFLICT",
    );
  });

  integrationTest("versions cannot be edited or deleted, by anyone", async () => {
    const statements = [
      `UPDATE app.ai_programme_versions SET min_seats = 99 WHERE version_number = 1`,
      `DELETE FROM app.ai_programme_version_tiers WHERE kind = 'conversion'`,
      `UPDATE app.ai_programme_version_prices SET iap_price_minor = 1`,
    ];
    for (const statement of statements) {
      expect(await refusal(asAdmin(null, (tx) => tx.unsafe(statement)))).toBe("55000");
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// School overrides
// ---------------------------------------------------------------------------------------------------

describe("school overrides", () => {
  integrationTest(
    "the school's values win where it sets them; clearing inherits again",
    async () => {
      const f = await school();
      const global = await asAdmin(null, currentAiProgrammeVersion);
      const fresh = await inSchool(f.schoolId, schoolAiProgramme);
      expect(fresh.override).toBeNull();
      expect(fresh.currencyCode).toBe("USD");
      expect(fresh.effective.overridden).toEqual([]);
      expect(fresh.effective.minSeats).toBe(global.settings.minSeats);

      const saved = await inSchool(f.schoolId, (tx) =>
        saveSchoolOverride(
          tx,
          f.schoolId,
          {
            ...EMPTY_FIELDS,
            // Parents at the licence price, per school: allowed.
            licensePriceMinor: 350,
            parentPriceMinor: 350,
            minSeats: 50,
            nonpaymentGraceDays: 45,
            conversionTiers: [
              { fromBps: 0, shareBps: 0 },
              { fromBps: 2000, shareBps: 500 },
            ],
            reason: "Pilot school",
            basedOnOverrideId: null,
          },
          operator,
        ),
      );
      expect(saved).toMatchObject({ versionNumber: 1, empty: false, reason: "Pilot school" });
      expect(saved!.override.priceCurrencyCode).toBe("USD");

      const view = await inSchool(f.schoolId, schoolAiProgramme);
      expect(view.effective).toMatchObject({
        licensePriceMinor: 350,
        parentPriceMinor: 350,
        iapPriceMinor: global.settings.prices[0]!.iapPriceMinor,
        minSeats: 50,
        nonpaymentGraceDays: 45,
        maxShareBps: global.settings.maxShareBps,
      });
      expect(view.effective.conversionTiers).toHaveLength(2);
      expect(view.effective.contentBonusTiers).toEqual(global.settings.contentBonusTiers);
      expect(view.effective.overridden).toEqual([
        "licensePriceMinor",
        "parentPriceMinor",
        "minSeats",
        "conversionTiers",
        "nonpaymentGraceDays",
      ]);

      // Audited in the school (system row) and in the operator's school.
      const audits = await asAdmin(
        f.schoolId,
        (tx) => tx`
        SELECT 1 FROM app.audit_logs
        WHERE school_id = ${f.schoolId}::uuid AND target_table = 'ai_programme_school_overrides'
      `,
      );
      expect(audits).toHaveLength(1);

      // A stale edit is a conflict.
      expect(
        await refusal(
          inSchool(f.schoolId, (tx) =>
            saveSchoolOverride(
              tx,
              f.schoolId,
              { ...EMPTY_FIELDS, minSeats: 40, reason: "Stale", basedOnOverrideId: null },
              operator,
            ),
          ),
        ),
      ).toBe("AI_PROGRAMME_VERSION_CONFLICT");

      const cleared = await inSchool(f.schoolId, (tx) =>
        clearSchoolOverride(
          tx,
          f.schoolId,
          { reason: "Pilot over", basedOnOverrideId: saved!.id },
          operator,
        ),
      );
      expect(cleared).toMatchObject({ versionNumber: 2, empty: true });
      const after = await inSchool(f.schoolId, schoolAiProgramme);
      expect(after.effective.overridden).toEqual([]);
      expect(after.effective.minSeats).toBe(global.settings.minSeats);
      const history = await inSchool(f.schoolId, listAiProgrammeOverrides);
      expect(history.map((h) => h.versionNumber)).toEqual([2, 1]);
      // Clearing again writes nothing.
      await inSchool(f.schoolId, (tx) =>
        clearSchoolOverride(tx, f.schoolId, { reason: "Again" }, operator),
      );
      expect(await inSchool(f.schoolId, listAiProgrammeOverrides)).toHaveLength(2);
    },
  );

  integrationTest("an override must still fit under the maximum it ends up with", async () => {
    const f = await school();
    expect(
      await refusal(
        inSchool(f.schoolId, (tx) =>
          saveSchoolOverride(
            tx,
            f.schoolId,
            { ...EMPTY_FIELDS, maxShareBps: 500, reason: "Lower cap" },
            operator,
          ),
        ),
      ),
    ).toBe("AI_PROGRAMME_SHARE_ABOVE_MAX");
    expect(
      await refusal(
        inSchool(f.schoolId, (tx) =>
          saveSchoolOverride(
            tx,
            f.schoolId,
            { ...EMPTY_FIELDS, minSeats: 0, reason: "Zero" },
            operator,
          ),
        ),
      ),
    ).toBe("AI_PROGRAMME_VALUE_OUT_OF_RANGE");
    const preview = await inSchool(f.schoolId, (tx) =>
      previewSchoolOverride(tx, { ...EMPTY_FIELDS, maxShareBps: 500 }),
    );
    expect(preview.issues.map((i) => i.code)).toContain("share_above_max");
    expect(preview.effective.maxShareBps).toBe(500);
  });

  integrationTest(
    "the runtime role reads only its own school's overrides and writes none",
    async () => {
      const a = await school("Override A");
      const b = await school("Override B");
      await inSchool(a.schoolId, (tx) =>
        saveSchoolOverride(
          tx,
          a.schoolId,
          {
            ...EMPTY_FIELDS,
            contentBonusTiers: [{ fromBps: 0, shareBps: 100 }],
            reason: "A's bonus",
          },
          operator,
        ),
      );
      const seenByB = await asApp(
        b.schoolId,
        (tx) => tx`
        SELECT (SELECT count(*)::int FROM app.ai_programme_school_overrides) AS overrides,
               (SELECT count(*)::int FROM app.ai_programme_school_override_tiers) AS tiers
      `,
      );
      expect(seenByB[0]).toEqual({ overrides: 0, tiers: 0 });
      const seenByA = await asApp(
        a.schoolId,
        (tx) => tx`SELECT count(*)::int AS n FROM app.ai_programme_school_overrides`,
      );
      expect(seenByA[0]!.n).toBe(1);
      // The global versions are readable (a school accepting a quote resolves its values) ...
      expect(
        (
          await asApp(
            b.schoolId,
            (tx) => tx`SELECT count(*)::int AS n FROM app.ai_programme_versions`,
          )
        )[0]!.n,
      ).toBeGreaterThan(0);
      // ... and nothing is writable by the runtime role.
      const denied = (statement: string) =>
        refusal(asApp(b.schoolId, (tx) => tx.unsafe(statement)));
      expect(
        await denied(
          `INSERT INTO app.ai_programme_school_overrides (school_id, version_number, reason, created_by, created_by_school_id)
         VALUES ('${b.schoolId}', 1, 'x', '${b.schoolId}', '${b.schoolId}')`,
        ),
      ).toBe("42501");
      expect(await denied(`DELETE FROM app.ai_programme_versions`)).toBe("42501");
    },
  );
});

// ---------------------------------------------------------------------------------------------------
// Quotes and licences keep their values
// ---------------------------------------------------------------------------------------------------

describe("quotes and licences", () => {
  integrationTest(
    "a quote snapshots the values in force; the licence keeps them until they are re-applied",
    async () => {
      const f = await school();
      const v1 = await asAdmin(null, currentAiProgrammeVersion);
      const quote = await as(f.schoolId, operator, async (tx) => {
        const q = await createQuote(tx, f.schoolId, newTerm(40), operator);
        return { result: await sendQuote(tx, f.schoolId, q.id, operator) };
      });
      const [stamp] = await asAdmin(
        f.schoolId,
        (tx) => tx<{ version_id: string; override_id: string | null }[]>`
          SELECT ai_programme_version_id::text AS version_id,
                 ai_programme_override_id::text AS override_id
          FROM app.license_quotes WHERE school_id = ${f.schoolId}::uuid AND id = ${quote.id}::uuid
        `,
      );
      expect(stamp).toEqual({ version_id: v1.id, override_id: null });

      // A new global version (60 days' grace) and a school override (minimum 35 seats) after pricing.
      const v2 = await asAdmin(null, async (tx) =>
        saveAiProgrammeVersion(tx, await nextVersion({ nonpaymentGraceDays: 60 }), operator),
      );
      await inSchool(f.schoolId, (tx) =>
        saveSchoolOverride(
          tx,
          f.schoolId,
          { ...EMPTY_FIELDS, minSeats: 35, reason: "Late deal" },
          operator,
        ),
      );

      // Accepting signs the licence with what the quote was priced with.
      const accepted = (await as(
        f.schoolId,
        f.admin,
        (tx) => acceptQuote(tx, f.schoolId, quote.id, f.admin) as never,
      )) as Awaited<ReturnType<typeof acceptQuote>>["result"];
      const licenseId = accepted.quote.licenseId!;
      const signed = await inSchool(f.schoolId, async (tx) =>
        licenseAiProgramme(tx, (await readLicense(tx, licenseId))!),
      );
      expect(signed.stamp).toMatchObject({
        versionId: v1.id,
        overrideId: null,
        nonpaymentGraceDays: v1.settings.nonpaymentGraceDays,
        current: false,
      });
      expect(signed.signed.minSeats).toBe(v1.settings.minSeats);
      expect(signed.current).toMatchObject({ minSeats: 35, nonpaymentGraceDays: 60 });
      expect(signed.currentVersionNumber).toBe(v2.versionNumber);
      expect(signed.changes).toEqual(expect.arrayContaining(["minSeats", "nonpaymentGraceDays"]));

      // The invoice's AI stop dates follow the licence's own grace period.
      const detail = await inSchool(f.schoolId, (tx) =>
        requireInvoiceDetail(tx, accepted.invoice.id, operator),
      );
      const due = detail.instalments[0]!.dueDate;
      const plus = (days: number) =>
        new Date(Date.parse(`${due}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
      expect(detail.instalments[0]!.aiStopDate).toBe(plus(v1.settings.nonpaymentGraceDays));

      // Re-applying needs a reason, then moves the licence onto the current values, audited.
      expect(
        await refusal(
          inSchool(f.schoolId, async (tx) =>
            reapplyAiProgramme(tx, f.schoolId, (await readLicense(tx, licenseId))!, " ", operator),
          ),
        ),
      ).toBe("AI_PROGRAMME_REASON_REQUIRED");
      const before = await asAdmin(f.schoolId, async (tx) => (await readLicense(tx, licenseId))!);
      const reapplied = await inSchool(f.schoolId, async (tx) =>
        reapplyAiProgramme(
          tx,
          f.schoolId,
          (await readLicense(tx, licenseId))!,
          "Agreed new terms",
          operator,
        ),
      );
      expect(reapplied.stamp).toMatchObject({
        versionId: v2.id,
        current: true,
        nonpaymentGraceDays: 60,
      });
      expect(reapplied.stamp.overrideId).not.toBeNull();
      expect(reapplied.changes).toEqual([]);
      const after = await asAdmin(f.schoolId, async (tx) => (await readLicense(tx, licenseId))!);
      // Re-applying is not a change of terms: an open quote on the licence does not go stale.
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
      expect(after.nonpaymentGraceDays).toBe(60);
      const detailAfter = await inSchool(f.schoolId, (tx) =>
        requireInvoiceDetail(tx, accepted.invoice.id, operator),
      );
      expect(detailAfter.instalments[0]!.aiStopDate).toBe(plus(60));
      const [audit] = await asAdmin(
        f.schoolId,
        (tx) => tx<{ new_values: Record<string, unknown> }[]>`
          SELECT new_values FROM app.audit_logs
          WHERE school_id = ${f.schoolId}::uuid AND target_table = 'school_licenses'
            AND target_id = ${licenseId}::uuid AND new_values ? 'ai_programme_reapplied'
        `,
      );
      expect(audit!.new_values).toMatchObject({
        reason: "Agreed new terms",
        ai_programme_version: v2.versionNumber,
        nonpayment_grace_days: 60,
      });
    },
  );

  integrationTest(
    "a licence made directly is signed with the values in force for its school",
    async () => {
      const f = await school();
      await inSchool(f.schoolId, (tx) =>
        saveSchoolOverride(
          tx,
          f.schoolId,
          { ...EMPTY_FIELDS, nonpaymentGraceDays: 20, reason: "Short grace" },
          operator,
        ),
      );
      const license = await inSchool(f.schoolId, (tx) =>
        createLicense(
          tx,
          f.schoolId,
          {
            startsAt: new Date(),
            endsAt: new Date(Date.now() + 300 * 86_400_000),
            currencyCode: "USD",
            includeFamilyPlus: false,
            student: { planId: studentTier, seats: 30 },
          },
          operator,
        ),
      );
      const current = await asAdmin(null, currentAiProgrammeVersion);
      expect(license.aiProgrammeVersionId).toBe(current.id);
      expect(license.aiProgrammeOverrideId).not.toBeNull();
      expect(license.nonpaymentGraceDays).toBe(20);
    },
  );
});

// ---------------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------------

describe("routes", () => {
  let api: TestApp;

  beforeAll(async () => {
    if (!integrationEnabled) return;
    const created = createTestApp({ database: db.sql });
    await created.ready;
    api = created;
  });

  const json = (body: unknown) => ({
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

  const asOperator = (method: string, path: string, body?: unknown) =>
    authenticatedRequest(
      api,
      method,
      path,
      {
        schoolId: hq,
        userId: operator.userId,
        roles: [ROLES.SUPER_ADMIN],
        channel: AUTH_CHANNELS.WEB,
      },
      body === undefined ? undefined : json(body),
    );

  integrationTest("the super admin reads and saves; nobody else does", async () => {
    const f = await school();
    const current = await asOperator("GET", "/api/platform/ai-programme");
    expect(current.status).toBe(200);
    const { current: version } = (await current.json()) as {
      current: { id: string; settings: AiProgrammeSettings };
    };

    const saved = await asOperator("POST", "/api/platform/ai-programme/versions", {
      ...version.settings,
      minSeats: 25,
      reason: "Smaller schools",
      basedOnVersionId: version.id,
    });
    expect(saved.status).toBe(201);
    const invalid = await asOperator("POST", "/api/platform/ai-programme/versions", {
      ...version.settings,
      reason: "Stale",
      basedOnVersionId: version.id,
    });
    expect(invalid.status).toBe(409);
    expect(((await invalid.json()) as { code: string }).code).toBe("AI_PROGRAMME_VERSION_CONFLICT");

    expect((await asOperator("GET", "/api/platform/ai-programme/versions")).status).toBe(200);
    const put = await asOperator(
      "PUT",
      `/api/platform/schools/${f.schoolId}/ai-programme/override`,
      {
        ...EMPTY_FIELDS,
        payoutMode: "payout",
        reason: "Paid out",
      },
    );
    expect(put.status).toBe(200);
    expect(((await put.json()) as { effective: { payoutMode: string } }).effective.payoutMode).toBe(
      "payout",
    );
    const preview = await asOperator(
      "POST",
      `/api/platform/schools/${f.schoolId}/ai-programme/preview`,
      {
        ...EMPTY_FIELDS,
        maxShareBps: 100,
      },
    );
    expect(preview.status).toBe(200);
    expect(
      ((await preview.json()) as { issues: { code: string }[] }).issues.length,
    ).toBeGreaterThan(0);
    expect(
      (await asOperator("GET", `/api/platform/schools/${f.schoolId}/ai-programme/overrides`))
        .status,
    ).toBe(200);
    expect(
      (await asOperator("GET", `/api/platform/schools/${crypto.randomUUID()}/ai-programme`)).status,
    ).toBe(404);

    // A school admin: forbidden on every route, including reading its own school's overrides.
    const admin = await createUser(db.sql, f.schoolId);
    await assignRole(db.sql, f.schoolId, admin.id, ROLES.ORG_ADMIN);
    const asSchoolAdmin = (method: string, path: string, body?: unknown) =>
      authenticatedRequest(
        api,
        method,
        path,
        {
          schoolId: f.schoolId,
          userId: admin.id,
          roles: [ROLES.ORG_ADMIN],
          channel: AUTH_CHANNELS.WEB,
        },
        body === undefined ? undefined : json(body),
      );
    for (const [method, path] of [
      ["GET", "/api/platform/ai-programme"],
      ["GET", `/api/platform/schools/${f.schoolId}/ai-programme`],
      ["POST", "/api/platform/ai-programme/versions"],
      ["PUT", `/api/platform/schools/${f.schoolId}/ai-programme/override`],
    ] as const) {
      expect([method, path, (await asSchoolAdmin(method, path, {})).status]).toEqual([
        method,
        path,
        403,
      ]);
    }
  });
});
