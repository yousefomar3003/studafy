// Measures token resolution rather than HTTP serialization: valid and invalid wire responses are
// intentionally different, while the security target is that digest lookup and state evaluation do
// not expose whether the unique hash index hit. Samples are interleaved after warmup so cache, JIT,
// and runner drift affect both populations evenly.

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { expect, test } from "bun:test";

import { hashInvitationToken, resolveInvitationToken } from "../../src/modules/auth";
import { createSchool, createTestDatabase, integrationEnabled, migrateDatabase } from "../harness";

const benchmarkTest = test.skipIf(
  process.env.INVITATION_VERIFICATION_BENCHMARK !== "1" || !integrationEnabled,
);

const WARMUP_PER_ARM = 200;
const SAMPLES_PER_ARM = 1_000;
const MEDIAN_DELTA_MS = 1;
const P95_DELTA_MS = 2;
const VALID_TOKEN = "a".repeat(64);
const MISSING_TOKEN = "b".repeat(64);

function percentile(samples: readonly number[], fraction: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return sorted[Math.max(index, 0)]!;
}

benchmarkTest(
  "keeps valid and missing invitation resolution distributions within the timing budget",
  async () => {
    const database = await createTestDatabase({ maxConnections: 1 });
    try {
      await migrateDatabase(database.url);
      const school = await createSchool(database.sql, { name: "Timing Academy" });

      await database.sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE studafy_admin");
        await tx`UPDATE app.schools SET status = 'active' WHERE id = ${school.id}`;
        await tx`SELECT set_config('app.school_id', ${school.id}, true)`;
        await tx`
          INSERT INTO app.invitations (
            school_id, email, normalized_email, role, token_hash, expires_at
          ) VALUES (
            ${school.id},
            'timing@example.test',
            'timing@example.test',
            'STUDENT'::app.user_role,
            ${hashInvitationToken(VALID_TOKEN)}::bytea,
            ${new Date(Date.now() + 24 * 60 * 60 * 1000)}
          )
        `;
      });

      for (let index = 0; index < WARMUP_PER_ARM; index += 1) {
        await resolveInvitationToken(database.sql, VALID_TOKEN);
        await resolveInvitationToken(database.sql, MISSING_TOKEN);
      }

      const schedule = Array.from({ length: SAMPLES_PER_ARM * 2 }, (_, index) => index % 2 === 0);
      // Deterministic shuffle: reproducible ordering with both arms evenly distributed.
      let seed = 0x75;
      for (let index = schedule.length - 1; index > 0; index -= 1) {
        seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
        const swapIndex = seed % (index + 1);
        [schedule[index], schedule[swapIndex]] = [schedule[swapIndex]!, schedule[index]!];
      }

      const validSamples: number[] = [];
      const missingSamples: number[] = [];
      for (const valid of schedule) {
        const startedAt = performance.now();
        const result = await resolveInvitationToken(
          database.sql,
          valid ? VALID_TOKEN : MISSING_TOKEN,
        );
        const elapsed = performance.now() - startedAt;
        (valid ? validSamples : missingSamples).push(elapsed);
        expect(result.authentic).toBe(valid);
      }

      const validMedian = percentile(validSamples, 0.5);
      const missingMedian = percentile(missingSamples, 0.5);
      const validP95 = percentile(validSamples, 0.95);
      const missingP95 = percentile(missingSamples, 0.95);
      const medianDelta = Math.abs(validMedian - missingMedian);
      const p95Delta = Math.abs(validP95 - missingP95);

      console.log(
        `invitation verification valid median=${validMedian.toFixed(3)}ms p95=${validP95.toFixed(3)}ms; ` +
          `missing median=${missingMedian.toFixed(3)}ms p95=${missingP95.toFixed(3)}ms; ` +
          `deltas median=${medianDelta.toFixed(3)}ms p95=${p95Delta.toFixed(3)}ms`,
      );

      expect(validSamples).toHaveLength(SAMPLES_PER_ARM);
      expect(missingSamples).toHaveLength(SAMPLES_PER_ARM);
      expect(medianDelta).toBeLessThan(MEDIAN_DELTA_MS);
      expect(p95Delta).toBeLessThan(P95_DELTA_MS);
    } finally {
      await database.cleanup();
    }
  },
  180_000,
);
