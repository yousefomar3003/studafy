/**
 * The school's sibling discount rule (000151). Applying it is the billing worker's job (it turns the
 * rule into an invoice discount, next to approved scholarships); this module reads and replaces the
 * rule, and counts how many children it reaches so the page can say what saving it would do.
 */

import {
  loadSiblingDiscountRule,
  loadSiblingStandings,
  siblingPercentageFor,
} from "@studafy/billing";

import { emitAuditLog } from "../../../middleware/auditEmitter";

import type { UpdateSiblingDiscountBody } from "./schemas";
import type { TransactionSql } from "postgres";

export interface SiblingDiscountRuleResponse {
  configured: boolean;
  is_enabled: boolean;
  fee_category: string | null;
  tiers: { child_position: number; percentage: number }[];
  updated_at: string | null;
  updated_by_name: string | null;
  discounted_children: number;
}

/** Runs as studafy_admin with the tenant scope set: it ranks students, which FINANCE cannot read. */
export async function getSiblingDiscountRule(
  tx: TransactionSql,
  schoolId: string,
): Promise<SiblingDiscountRuleResponse> {
  const rule = await loadSiblingDiscountRule(tx, schoolId);
  if (!rule) {
    return {
      configured: false,
      is_enabled: false,
      fee_category: null,
      tiers: [],
      updated_at: null,
      updated_by_name: null,
      discounted_children: 0,
    };
  }

  const [meta] = await tx<{ updated_at: Date; updated_by_name: string | null }[]>`
    SELECT settings.updated_at, coalesce(editor.display_name, editor.email) AS updated_by_name
    FROM app.sibling_discount_settings AS settings
    LEFT JOIN app.users AS editor
      ON editor.id = settings.updated_by AND editor.school_id = settings.school_id
    WHERE settings.school_id = ${schoolId}::uuid
  `;

  let discounted = 0;
  if (rule.is_enabled) {
    for (const standing of (await loadSiblingStandings(tx, schoolId)).values()) {
      if (siblingPercentageFor(rule, standing) !== null) discounted += 1;
    }
  }

  return {
    configured: true,
    is_enabled: rule.is_enabled,
    fee_category: rule.fee_category,
    tiers: rule.tiers.map((tier) => ({
      child_position: tier.child_position,
      percentage: Number(tier.percentage),
    })),
    updated_at: meta?.updated_at.toISOString() ?? null,
    updated_by_name: meta?.updated_by_name ?? null,
    discounted_children: discounted,
  };
}

/** Replace the rule. Invoices already issued keep their discount; only new invoices see the change. */
export async function replaceSiblingDiscountRule(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  body: UpdateSiblingDiscountBody,
): Promise<void> {
  const before = await loadSiblingDiscountRule(tx, schoolId);
  const feeCategory = body.fee_category ?? null;

  await tx`
    INSERT INTO app.sibling_discount_settings (school_id, is_enabled, fee_category, updated_by)
    VALUES (${schoolId}::uuid, ${body.is_enabled}, ${feeCategory}, ${userId}::uuid)
    ON CONFLICT (school_id) DO UPDATE
      SET is_enabled = EXCLUDED.is_enabled,
          fee_category = EXCLUDED.fee_category,
          updated_by = EXCLUDED.updated_by,
          updated_at = CURRENT_TIMESTAMP
  `;
  await tx`DELETE FROM app.sibling_discount_tiers WHERE school_id = ${schoolId}::uuid`;
  for (const tier of body.tiers) {
    await tx`
      INSERT INTO app.sibling_discount_tiers (school_id, child_position, percentage)
      VALUES (${schoolId}::uuid, ${tier.child_position}, ${tier.percentage})
    `;
  }

  const tiersOf = (tiers: readonly { child_position: number; percentage: string | number }[]) =>
    [...tiers]
      .sort((a, b) => a.child_position - b.child_position)
      .map((tier) => ({
        child_position: tier.child_position,
        percentage: Number(tier.percentage),
      }));

  await emitAuditLog(tx, {
    action: before ? "update" : "insert",
    targetTable: "sibling_discount_settings",
    targetId: schoolId,
    oldValues: before
      ? {
          is_enabled: before.is_enabled,
          fee_category: before.fee_category,
          tiers: tiersOf(before.tiers),
        }
      : null,
    newValues: {
      is_enabled: body.is_enabled,
      fee_category: feeCategory,
      tiers: tiersOf(body.tiers),
    },
  });
}
