/**
 * Characterization check shared by the grading integration tests: every set-based read path must
 * return exactly what the per-row reference implementation (legacy-grading.ts) returns on the same
 * database — same values, same order, same keys, same errors.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { expect } from "bun:test";

import { CodedHttpException } from "../../../coded-http-exception";
import { certificateReadiness } from "../certificate-service";
import {
  collectPublishIssues,
  getConfigView,
  listConfigSummaries,
  listGradeConfigs,
  listPrograms,
} from "../config-service";
import { listMyAssignments } from "../marks-service";
import { getGradingOverview } from "../overview-service";
import { computeSection } from "../results-service";

import {
  legacyCertificateReadiness,
  legacyCollectPublishIssues,
  legacyComputeSection,
  legacyGetGradingOverview,
  legacyListConfigSummaries,
  legacyListMyAssignments,
} from "./legacy-grading";

import type { MyAssignment } from "../marks-service";
import type { TransactionSql } from "postgres";

type Run = <T>(fn: (tx: TransactionSql) => Promise<T>) => Promise<T>;

/** The value, or the error code it failed with. */
async function settle<T>(promise: Promise<T>): Promise<{ value?: T; error?: string }> {
  try {
    return { value: await promise };
  } catch (error) {
    if (error instanceof CodedHttpException) return { error: `${error.code}: ${error.message}` };
    throw error;
  }
}

async function same<T>(label: string, actual: Promise<T>, expected: Promise<T>): Promise<void> {
  const [a, e] = [await settle(actual), await settle(expected)];
  if (e.error !== undefined || a.error !== undefined) {
    expect({ label, error: a.error }).toEqual({ label, error: e.error });
    return;
  }
  expect(a.value).toStrictEqual(e.value as T);
  // Byte-identical once serialized, key order included: what the API sends.
  expect(`${label}: ${JSON.stringify(a.value)}`).toBe(`${label}: ${JSON.stringify(e.value)}`);
}

/** Sheets of an assignment had no defined order before; compare them as a set. */
export function normalizeAssignments(rows: MyAssignment[]): MyAssignment[] {
  return rows.map((row) => ({
    ...row,
    sheets: [...row.sheets].sort((a, b) => (a.term_id ?? "~").localeCompare(b.term_id ?? "~")),
  }));
}

export async function expectSameAsLegacy(
  admin: Run,
  schoolId: string,
  yearId: string,
  teachers: Run[] = [],
): Promise<{ sectionsCompared: number }> {
  await same(
    "overview",
    admin((tx) => getGradingOverview(tx, schoolId, yearId)),
    admin((tx) => legacyGetGradingOverview(tx, schoolId, yearId)),
  );
  await same(
    "publish issues",
    admin((tx) => collectPublishIssues(tx, schoolId, yearId)),
    admin((tx) => legacyCollectPublishIssues(tx, schoolId, yearId)),
  );
  await same(
    "config summaries",
    admin((tx) => listConfigSummaries(tx, schoolId, yearId)),
    admin((tx) => legacyListConfigSummaries(tx, schoolId, yearId)),
  );

  const { sections, terms, finalizations } = await admin(async (tx) => ({
    sections: await tx<{ id: string }[]>`
      SELECT id FROM app.sections
      WHERE school_id = ${schoolId}::uuid AND academic_year_id = ${yearId}::uuid ORDER BY name
    `,
    terms: await tx<{ id: string }[]>`
      SELECT id FROM app.terms
      WHERE school_id = ${schoolId}::uuid AND academic_year_id = ${yearId}::uuid
      ORDER BY sequence_number
    `,
    finalizations: await tx<{ id: string }[]>`
      SELECT id FROM app.result_finalizations
      WHERE school_id = ${schoolId}::uuid AND academic_year_id = ${yearId}::uuid ORDER BY id
    `,
  }));
  for (const section of sections) {
    for (const termId of [null, ...terms.map((term) => term.id)]) {
      await same(
        `section ${section.id} term ${termId}`,
        admin((tx) => computeSection(tx, schoolId, section.id, termId)),
        admin((tx) => legacyComputeSection(tx, schoolId, section.id, termId)),
      );
    }
  }
  for (const finalization of finalizations) {
    await same(
      `readiness ${finalization.id}`,
      admin((tx) => certificateReadiness(tx, schoolId, finalization.id)),
      admin((tx) => legacyCertificateReadiness(tx, schoolId, finalization.id)),
    );
  }

  const programs = await admin((tx) => listPrograms(tx, schoolId, yearId));
  for (const program of programs) {
    await same(
      `grade configs ${program.grade_level_id}`,
      admin((tx) => listGradeConfigs(tx, schoolId, yearId, program.grade_level_id)),
      admin(async (tx) => {
        const rows = await tx<{ id: string }[]>`
          SELECT config.id
          FROM app.subject_configs AS config
          JOIN app.subjects AS subject ON subject.id = config.subject_id AND subject.school_id = config.school_id
          WHERE config.school_id = ${schoolId}::uuid AND config.academic_year_id = ${yearId}::uuid
            AND config.grade_level_id = ${program.grade_level_id}::uuid AND config.section_id IS NULL
          ORDER BY subject.name
        `;
        const views = [];
        for (const row of rows) views.push(await getConfigView(tx, schoolId, row.id));
        return views;
      }),
    );
  }

  for (const [index, teacher] of teachers.entries()) {
    for (const year of [yearId, undefined]) {
      await same(
        `assignments of teacher ${index} (${year ?? "current year"})`,
        teacher((tx) => listMyAssignments(tx, schoolId, year).then(normalizeAssignments)),
        teacher((tx) => legacyListMyAssignments(tx, schoolId, year).then(normalizeAssignments)),
      );
    }
  }
  return { sectionsCompared: sections.length };
}
