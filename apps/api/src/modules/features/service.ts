import { createFeatureCatalogSource } from "./catalog";
import { collectGrants } from "./grants";
import { readLicenseContext } from "./license-context";
import { resolveFeatureAccess } from "./resolve";
import { createFeatureUsageMeter } from "./usage";

import type { FeatureCatalog, FeatureCatalogSource } from "./catalog";
import type { GrantSourceAdapter, PersonEntitlements } from "./grants";
import type { LicenseContext } from "./license-context";
import type { FeatureAccessMap } from "./resolve";
import type { FeatureUsageMeter } from "./usage";
import type { Database, DatabasePools } from "../../db/client";
import type { Logger } from "../../logger";
import type { EntitlementService } from "../subscriptions/entitlements/service";

/**
 * The feature service: who has which paid feature, now.
 *
 * Every entitlement read goes through the ST-133 entitlement service, so it is served from the
 * version-guarded Redis cache and invalidated the moment a grant or the school changes:
 * `ent:{schoolId}` for the school, `ent:ai:{studentId}` for the AI add-on, `ent:usr:{userId}` for
 * everything else a person holds. The catalog (tiers and feature settings) is cached per process.
 */

/**
 * Whose features. A route acting on the caller passes the user; the AI routes act on the student in
 * their path (whoever calls them -- that is today's AI access rule, kept as is).
 */
export type FeatureSubject = { userId: string } | { studentId: string };

export interface ResolvedFeatures {
  schoolId: string;
  /** The person's user id; null only for a student id that names no student in the school. */
  userId: string | null;
  /** The person's student record, or null for a non-student. */
  studentId: string | null;
  features: FeatureAccessMap;
}

export interface ResolveOptions {
  /** Read this month's usage too. Off for a gate check, which meters on its own. */
  withUsage?: boolean;
  now?: Date;
}

export interface FeatureService {
  resolve(
    schoolId: string,
    subject: FeatureSubject,
    options?: ResolveOptions,
  ): Promise<ResolvedFeatures>;
  /** Every feature for one person, with this month's usage. */
  resolveFeatures(schoolId: string, userId: string): Promise<FeatureAccessMap>;
  catalog(): Promise<FeatureCatalog>;
  /**
   * The school's license as it bears on these people: the school's name, what the license in force
   * sells, who holds a seat, whose personal renewal a seat turned off. Read per request, not cached:
   * only the feature list and the purchase offer ask, never a gated route.
   */
  licenseContext(schoolId: string, userIds: readonly string[]): Promise<LicenseContext>;
  usage: FeatureUsageMeter;
}

export interface FeatureServiceDeps {
  database: Database | DatabasePools;
  entitlements: Pick<EntitlementService, "school" | "ai" | "user">;
  logger: Logger;
  /** Injected in tests. */
  catalog?: FeatureCatalogSource;
  usage?: FeatureUsageMeter;
  grantSources?: readonly GrantSourceAdapter[];
}

export function createFeatureService(deps: FeatureServiceDeps): FeatureService {
  const { database, entitlements, logger, grantSources } = deps;
  const catalogSource = deps.catalog ?? createFeatureCatalogSource({ database, logger });
  const usage = deps.usage ?? createFeatureUsageMeter({ database });

  async function person(
    schoolId: string,
    subject: FeatureSubject,
  ): Promise<{
    schoolActive: boolean;
    entitlements: PersonEntitlements | null;
    userId: string | null;
  }> {
    if ("studentId" in subject) {
      const [school, ai] = await Promise.all([
        entitlements.school(schoolId),
        entitlements.ai(schoolId, subject.studentId),
      ]);
      if (!ai.userId) return { schoolActive: school.active, entitlements: null, userId: null };
      const user = await entitlements.user(schoolId, ai.userId);
      return { schoolActive: school.active, entitlements: { ai, user }, userId: ai.userId };
    }

    const [school, user] = await Promise.all([
      entitlements.school(schoolId),
      entitlements.user(schoolId, subject.userId),
    ]);
    const ai = user.studentId ? await entitlements.ai(schoolId, user.studentId) : null;
    return { schoolActive: school.active, entitlements: { ai, user }, userId: subject.userId };
  }

  async function resolve(
    schoolId: string,
    subject: FeatureSubject,
    options: ResolveOptions = {},
  ): Promise<ResolvedFeatures> {
    const [resolved, catalog] = await Promise.all([person(schoolId, subject), catalogSource.get()]);
    const used =
      options.withUsage && resolved.userId
        ? await usage.read(schoolId, resolved.userId, options.now)
        : {};

    return {
      schoolId,
      userId: resolved.userId,
      studentId: resolved.entitlements?.user.studentId ?? null,
      features: resolveFeatureAccess({
        catalog,
        grants: resolved.entitlements
          ? collectGrants(resolved.entitlements, options.now ?? new Date(), grantSources)
          : [],
        schoolActive: resolved.schoolActive,
        usage: used,
      }),
    };
  }

  return {
    resolve,
    async resolveFeatures(schoolId, userId) {
      return (await resolve(schoolId, { userId }, { withUsage: true })).features;
    },
    catalog: () => catalogSource.get(),
    licenseContext: (schoolId, userIds) => readLicenseContext(database, { schoolId, userIds }),
    usage,
  };
}
