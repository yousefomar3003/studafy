/**
 * Every feature flag across every school, for the platform console.
 *
 * Flags resolve per request as: a school's override row in app.feature_flags, else the deployment
 * default (env, e.g. AI_LLM_ENABLED), else the registry default (packages/constants
 * feature-flags.ts). There is no database-held global default, so a fleet-wide change stays an env
 * change and this view does not offer a "set for every school" write -- it shows the deployment
 * default and which schools override it. Changing one school stays on the school's own page
 * (PUT /api/platform/schools/{schoolId}/feature-flags/{flagName}).
 */

import { FEATURE_FLAGS } from "@studafy/constants";

import { pipelinePerSchool, withSystemTx } from "../../../db/tenant-tx";

import type { Database } from "../../../db/client";
import type { FlagsService } from "../../flags";
import type { FeatureFlagDefinition, FlagName } from "@studafy/constants";

export interface FlagOverview {
  name: FlagName;
  description: string;
  registryDefault: boolean;
  /** What a school with no override gets in this deployment. */
  deploymentDefault: boolean;
  overrides: { schoolId: string; schoolName: string; schoolStatus: string; enabled: boolean }[];
  /** Schools for which the flag is on right now, overrides and default together. */
  enabledSchools: number;
  totalSchools: number;
}

export async function listFlagsAcrossSchools(
  database: Database,
  flags: FlagsService | null,
): Promise<FlagOverview[]> {
  const { schools, rows } = await withSystemTx(database, async (tx) => {
    const schools = await tx<{ id: string; name: string; status: string }[]>`
      SELECT id, name, status::text AS status FROM app.schools ORDER BY name
    `;
    const rows = await pipelinePerSchool(tx, schools, () => [
      tx<{ flag_name: string; enabled: boolean }[]>`
        SELECT flag_name, enabled FROM app.feature_flags
      `,
    ]);
    return { schools, rows };
  });

  const entries = Object.entries(FEATURE_FLAGS) as [FlagName, FeatureFlagDefinition][];
  const result: FlagOverview[] = [];
  for (const [name, definition] of entries) {
    // No schoolId: the flags service answers with the deployment default, no database read.
    const deploymentDefault = flags ? await flags.get(name) : definition.defaultValue;
    const overrides = schools.flatMap((school, index) => {
      const row = rows[index]![0].find((override) => override.flag_name === name);
      return row
        ? [
            {
              schoolId: school.id,
              schoolName: school.name,
              schoolStatus: school.status,
              enabled: row.enabled,
            },
          ]
        : [];
    });
    const overridden = new Map(overrides.map((override) => [override.schoolId, override.enabled]));
    const enabledSchools = schools.filter(
      (school) => overridden.get(school.id) ?? deploymentDefault,
    ).length;
    result.push({
      name,
      description: definition.description,
      registryDefault: definition.defaultValue,
      deploymentDefault,
      overrides,
      enabledSchools,
      totalSchools: schools.length,
    });
  }
  return result;
}
