import { schoolCalendar, uploadConsistency } from "@studafy/billing";
import { contentBonusStanding } from "@studafy/license-pricing";

import {
  currentAiProgrammeStamp,
  resolveAiProgrammeValues,
  schoolCurrencyCode,
} from "./ai-programme";
import { currentLicense } from "./service";

import type { AiProgrammeStamp } from "./ai-programme";
import type { LicenseRecord } from "./service";
import type { UploadConsistencyReport, UploadPeriod } from "@studafy/billing";
import type { AiProgrammeTier, ContentBonusStanding } from "@studafy/license-pricing";
import type { TransactionSql } from "postgres";

/**
 * Upload consistency for the Student AI programme's content bonus (phase 4; decision 10 of the
 * plan; docs/billing/ai-upload-consistency.md): the share of school days on which a class's teachers
 * published a lesson or material, per class, per teacher and averaged for the school, over any
 * [from, to].
 *
 * The database read itself -- the school's calendar, the classes that have Student AI
 * (`studentAiClassIds`) and the days each published on -- lives in @studafy/billing
 * (ai-revenue-share/upload-consistency.ts), because the revenue share engine measures the bonus with
 * it too, in the API and in the workers' hourly job. This module adds the views: the current period
 * to date and the bonus tier it falls in. Nothing is written, and money is not computed here.
 */

export {
  schoolCalendar,
  studentAiClassIds,
  uploadConsistency,
  type UploadConsistencyClassView,
  type UploadConsistencyReport,
  type UploadConsistencyTeacherView,
  type UploadPeriod,
} from "@studafy/billing";

// ---------------------------------------------------------------------------------------------------
// The period to date, and the bonus tier it falls in
// ---------------------------------------------------------------------------------------------------

export type UploadPeriodBasis = "requested" | "license" | "academic_year" | "today";

/**
 * "The current period to date" for the armed school: from the start of its current licence (the
 * one `currentLicense` picks) to today, or to the licence's end once it has ended; with no licence,
 * from the start of the academic year that contains today; with neither, just today. Days in the
 * school's timezone.
 */
export async function currentUploadPeriod(
  tx: TransactionSql,
  license: LicenseRecord | null,
): Promise<UploadPeriod & { basis: Exclude<UploadPeriodBasis, "requested"> }> {
  const { timezone, today } = await schoolCalendar(tx);
  if (license) {
    // ends_at is the first instant after the licence: its last day is the day of the instant before.
    const [row] = await tx<{ first: string; last: string }[]>`
      SELECT (${license.startsAt}::timestamptz AT TIME ZONE ${timezone})::date::text AS first,
             ((${license.endsAt}::timestamptz - interval '1 microsecond') AT TIME ZONE ${timezone})
               ::date::text AS last
    `;
    const to = row!.last < today ? row!.last : today;
    return { from: row!.first <= to ? row!.first : to, to, basis: "license" };
  }
  const [year] = await tx<{ starts_on: string }[]>`
    SELECT starts_on::text AS starts_on
    FROM app.academic_years
    WHERE school_id = current_setting('app.school_id')::uuid
      AND starts_on <= ${today}::date AND ends_on >= ${today}::date
    ORDER BY starts_on DESC
    LIMIT 1
  `;
  if (year) return { from: year.starts_on, to: today, basis: "academic_year" };
  return { from: today, to: today, basis: "today" };
}

/**
 * The content-bonus tiers a stamp resolves to (the school override's own table when that override
 * version has rows of the kind, else the global version's -- resolveAiProgramme, 000234), through
 * the core resolver `resolveAiProgrammeValues`, which never looks up the super admins' names and so
 * is safe in a school's own request. Tiers do not depend on the currency; the school's is used.
 */
export async function contentBonusTiersFor(
  tx: TransactionSql,
  stamp: AiProgrammeStamp,
): Promise<AiProgrammeTier[]> {
  const values = await resolveAiProgrammeValues(tx, stamp, await schoolCurrencyCode(tx));
  return values.contentBonusTiers;
}

export interface UploadConsistencyBonusView extends ContentBonusStanding {
  /** The licence whose values the tiers come from; null when the school has none (current values). */
  licenseId: string | null;
  /** `license`: the values the licence was signed with. `school`: the school's values in force now. */
  source: "license" | "school";
  tiers: AiProgrammeTier[];
}

/**
 * Which content-bonus tier a consistency falls in, on the licence's own values (or the school's
 * current values when it has no licence). The tier only: no money, and no conversion rule.
 */
export async function uploadConsistencyBonus(
  tx: TransactionSql,
  consistencyBps: number | null,
  license: LicenseRecord | null,
): Promise<UploadConsistencyBonusView> {
  const stamp: AiProgrammeStamp = license
    ? { versionId: license.aiProgrammeVersionId, overrideId: license.aiProgrammeOverrideId }
    : await currentAiProgrammeStamp(tx);
  const tiers = await contentBonusTiersFor(tx, stamp);
  return {
    licenseId: license?.id ?? null,
    source: license ? "license" : "school",
    tiers,
    ...contentBonusStanding(tiers, consistencyBps),
  };
}

export interface UploadConsistencyView extends UploadConsistencyReport {
  basis: UploadPeriodBasis;
  bonus: UploadConsistencyBonusView;
}

/**
 * What the routes answer: the armed school's upload consistency over the requested days (the current
 * period to date when none are given), with the bonus tier on its current licence's values.
 */
export async function uploadConsistencyView(
  tx: TransactionSql,
  requested: UploadPeriod | null,
): Promise<UploadConsistencyView> {
  const license = await currentLicense(tx);
  const current = requested ? null : await currentUploadPeriod(tx, license);
  const report = await uploadConsistency(tx, requested ?? current!);
  return {
    ...report,
    basis: current?.basis ?? "requested",
    bonus: await uploadConsistencyBonus(tx, report.consistencyBps, license),
  };
}
