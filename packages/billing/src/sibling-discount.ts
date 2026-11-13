/**
 * Sibling discounts (000151): who counts as a sibling, which child is which, and what each child's
 * tier is. Shared by apps/workers, which applies the discount when it generates an invoice, and
 * apps/api, which shows finance which child gets which discount before any invoice exists. Both must
 * agree on the ranking, which is why this is a package and not a copy.
 *
 * - Siblings are enrolled students sharing a family through app.parent_child_links. A withdrawn or
 *   graduated child no longer counts, so a younger sibling can move up a position.
 * - Children are ranked eldest first by date of birth (then admission number, so the order is total
 *   and stable). The eldest is position 1 and pays full fees.
 * - A tier applies from its position upward until a higher tier takes over: {2: 10, 3: 15} means
 *   the second child gets 10% and the third and every later child 15%.
 * - A child in two families (separated guardians who each hold a family) takes the better position.
 *
 * Callers run these reads as `studafy_admin` with the tenant scope set: FINANCE cannot read
 * app.students under its role-scope policy (see withStudentIdentityTx in apps/api).
 */

import type { TransactionSql } from "postgres";

export interface SiblingDiscountTier {
  /** 2 is the second child. */
  child_position: number;
  /** Decimal string as stored, e.g. "12.50". */
  percentage: string;
}

export interface SiblingDiscountRule {
  is_enabled: boolean;
  /** NULL discounts every fee; otherwise only invoice lines of this category. */
  fee_category: string | null;
  /** Ascending by child_position. */
  tiers: SiblingDiscountTier[];
}

export interface SiblingStanding {
  student_id: string;
  family_id: string;
  /** 1 is the eldest enrolled child of the family. */
  child_position: number;
  /** Enrolled children in that family, this one included. */
  sibling_count: number;
}

/**
 * The percentage a child at `position` gets under `tiers`, or null for none. Tiers need not be
 * sorted; the highest tier at or below the position wins.
 */
export function tierPercentageFor(
  position: number,
  tiers: readonly SiblingDiscountTier[],
): string | null {
  let best: SiblingDiscountTier | null = null;
  for (const tier of tiers) {
    if (tier.child_position <= position && (!best || tier.child_position > best.child_position)) {
      best = tier;
    }
  }
  return best?.percentage ?? null;
}

/** The school's rule, or null when it has never been configured. */
export async function loadSiblingDiscountRule(
  tx: TransactionSql,
  schoolId: string,
): Promise<SiblingDiscountRule | null> {
  const [settings] = await tx<{ is_enabled: boolean; fee_category: string | null }[]>`
    SELECT is_enabled, fee_category
    FROM app.sibling_discount_settings
    WHERE school_id = ${schoolId}::uuid
  `;
  if (!settings) return null;
  const tiers = await tx<{ child_position: number; percentage: string }[]>`
    SELECT child_position, percentage::text AS percentage
    FROM app.sibling_discount_tiers
    WHERE school_id = ${schoolId}::uuid
    ORDER BY child_position
  `;
  return { ...settings, tiers: [...tiers] };
}

/**
 * Each enrolled student's place among their siblings, keyed by student id. A student with no family
 * link, or who is not enrolled, is absent. `studentIds` narrows the result; omitted, every enrolled
 * student with a family is ranked.
 */
export async function loadSiblingStandings(
  tx: TransactionSql,
  schoolId: string,
  studentIds?: readonly string[],
): Promise<Map<string, SiblingStanding>> {
  const narrow =
    studentIds === undefined ? tx`` : tx`WHERE student_id = ANY(${[...studentIds]}::uuid[])`;
  const rows = await tx<
    { student_id: string; family_id: string; child_position: number; sibling_count: number }[]
  >`
    WITH members AS (
      SELECT DISTINCT link.family_id, student.id AS student_id, student.date_of_birth,
             student.admission_number
      FROM app.parent_child_links AS link
      JOIN app.students AS student
        ON student.id = link.student_id AND student.school_id = link.school_id
      WHERE link.school_id = ${schoolId}::uuid
        AND student.status = 'enrolled'
    ),
    ranked AS (
      SELECT family_id, student_id,
             row_number() OVER (
               PARTITION BY family_id
               ORDER BY date_of_birth ASC NULLS LAST, admission_number, student_id
             )::int AS child_position,
             count(*) OVER (PARTITION BY family_id)::int AS sibling_count
      FROM members
    )
    SELECT student_id, family_id, child_position, sibling_count
    FROM ranked
    ${narrow}
    ORDER BY student_id, child_position DESC, family_id
  `;

  // Ordered by position descending within a student, so the first row seen is the better standing.
  const standings = new Map<string, SiblingStanding>();
  for (const row of rows) {
    if (!standings.has(row.student_id)) standings.set(row.student_id, { ...row });
  }
  return standings;
}

/**
 * The percentage the rule gives one student, or null when the rule is off, the student has no
 * siblings, or no tier reaches their position.
 */
export function siblingPercentageFor(
  rule: SiblingDiscountRule | null,
  standing: SiblingStanding | undefined,
): string | null {
  if (!rule?.is_enabled || !standing) return null;
  return tierPercentageFor(standing.child_position, rule.tiers);
}
