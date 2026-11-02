import { FEATURES } from "@studafy/constants";

import { withTenantTx } from "../../db/tenant-tx";

import { tierIncludes } from "./resolve";

import type { FeatureCatalog } from "./catalog";
import type { Database, DatabasePools } from "../../db/client";
import type { FeatureAudience, FeatureKey } from "@studafy/constants";

/**
 * What the school's license means for the people asking, beyond their own grants (session 6 of
 * docs/billing/feature-licensing.md): the school's name ("Provided by …"), which tiers the license in
 * force sells per audience (so an uncovered person is told to ask the school for a seat instead of
 * being sold a personal purchase), who holds a seat on it, and whose personal renewal a seat turned
 * off (session 2's overlap rows).
 *
 * "In force" is the grant adapter's rule (./grants.ts, licenseSeatGrants): status active and the
 * clock inside the license period.
 */

export interface RenewalStop {
  audience: FeatureAudience;
  /** `app_store`, `google_play`, `tap`, `stripe`, or null when it could not be told. */
  provider: string | null;
  /** `cancel_at_period_end` (done for them) or `notify_user` (App Store: they must turn it off). */
  action: "cancel_at_period_end" | "notify_user";
  /** `done`, `pending`, `failed` (the provider call), `notified`... as session 2 records it. */
  status: string;
}

export interface LicenseContext {
  schoolName: string;
  /** The tier (plan code) the license in force sells per audience, for audiences with seats. */
  offeredTiers: Partial<Record<FeatureAudience, string>>;
  /** Per user asked about: the audiences they hold a seat of on the license in force. */
  seats: Record<string, FeatureAudience[]>;
  /** Per user asked about: renewals their seats turned off (the latest per audience). */
  renewalStops: Record<string, RenewalStop[]>;
}

export async function readLicenseContext(
  database: Database | DatabasePools,
  input: { schoolId: string; userIds: readonly string[]; now?: Date; requestId?: string },
): Promise<LicenseContext> {
  const now = input.now ?? new Date();
  const userIds = [...new Set(input.userIds)];

  return withTenantTx(
    database,
    { schoolId: input.schoolId, requestId: input.requestId },
    async (tx) => {
      const [school] = await tx<{ name: string }[]>`
      SELECT name FROM app.schools WHERE id = current_setting('app.school_id')::uuid
    `;
      const [license] = await tx<
        {
          id: string;
          student_code: string | null;
          teacher_code: string | null;
          parent_code: string | null;
          student_seats: number;
          teacher_seats: number;
          parent_seats: number;
          include_family_plus: boolean;
        }[]
      >`
      SELECT l.id::text AS id,
             sp.code AS student_code, tp.code AS teacher_code, pp.code AS parent_code,
             l.student_seats, l.teacher_seats, l.parent_seats, l.include_family_plus
      FROM app.school_licenses AS l
      LEFT JOIN app.plans AS sp ON sp.id = l.student_plan_id
      LEFT JOIN app.plans AS tp ON tp.id = l.teacher_plan_id
      LEFT JOIN app.plans AS pp ON pp.id = l.parent_plan_id
      WHERE l.school_id = current_setting('app.school_id')::uuid
        AND l.status = 'active'
        AND l.starts_at <= ${now}
        AND l.ends_at > ${now}
      LIMIT 1
    `;

      const offeredTiers: Partial<Record<FeatureAudience, string>> = {};
      if (license) {
        if (license.student_code && license.student_seats > 0) {
          offeredTiers.student = license.student_code;
        }
        if (license.teacher_code && license.teacher_seats > 0) {
          offeredTiers.teacher = license.teacher_code;
        }
        if (license.include_family_plus && license.parent_code && license.parent_seats > 0) {
          offeredTiers.parent = license.parent_code;
        }
      }

      const seats: Record<string, FeatureAudience[]> = Object.fromEntries(
        userIds.map((id) => [id, []]),
      );
      const renewalStops: Record<string, RenewalStop[]> = Object.fromEntries(
        userIds.map((id) => [id, []]),
      );
      if (license && userIds.length > 0) {
        const seatRows = await tx<{ user_id: string; audience: FeatureAudience }[]>`
        SELECT user_id::text AS user_id, audience
        FROM app.license_seats
        WHERE school_id = current_setting('app.school_id')::uuid
          AND license_id = ${license.id}::uuid
          AND unassigned_at IS NULL
          AND user_id = ANY(${userIds}::uuid[])
      `;
        for (const row of seatRows) seats[row.user_id]!.push(row.audience);

        const stopRows = await tx<
          {
            user_id: string;
            audience: FeatureAudience;
            provider: string | null;
            renewal_action: RenewalStop["action"];
            renewal_status: string;
          }[]
        >`
        SELECT DISTINCT ON (o.user_id, s.audience)
               o.user_id::text AS user_id, s.audience, o.provider, o.renewal_action,
               o.renewal_status
        FROM app.license_seat_overlaps AS o
        JOIN app.license_seats AS s ON s.id = o.seat_id AND s.school_id = o.school_id
        WHERE o.school_id = current_setting('app.school_id')::uuid
          AND s.license_id = ${license.id}::uuid
          AND s.unassigned_at IS NULL
          AND o.user_id = ANY(${userIds}::uuid[])
          AND o.renewal_action <> 'none'
        ORDER BY o.user_id, s.audience, o.created_at DESC
      `;
        for (const row of stopRows) {
          renewalStops[row.user_id]!.push({
            audience: row.audience,
            provider: row.provider,
            action: row.renewal_action,
            status: row.renewal_status,
          });
        }
      }

      return { schoolName: school?.name ?? "", offeredTiers, seats, renewalStops };
    },
  );
}

/** Whether the license in force sells a seat whose tier includes `key`. Pure. */
export function schoolOffersFeature(
  catalog: FeatureCatalog,
  offeredTiers: LicenseContext["offeredTiers"],
  key: FeatureKey,
): boolean {
  const code = offeredTiers[FEATURES[key].audience];
  const tier = code ? catalog.tiers[code] : undefined;
  return tier ? tierIncludes(tier, key).included : false;
}
