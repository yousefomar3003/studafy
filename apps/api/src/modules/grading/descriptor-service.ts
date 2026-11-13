import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../coded-http-exception";
import { emitAuditLog } from "../../middleware/auditEmitter";

import { loadDescriptorRows, toEngineDescriptors } from "./engine-config";

import type { SubjectConfigInput } from "./config-service";
import type { ProgramRow } from "./engine-config";
import type { EngineDescriptor } from "@studafy/grading-engine";
import type { TransactionSql } from "postgres";

/**
 * Descriptor scales for descriptive grading (kindergarten and early primary): each grade of each
 * academic year has one ordered list of descriptors ("Excellent" ... "Needs improvement") that
 * teachers choose from instead of entering marks. See db/migrations/000210_descriptive_grading.sql
 * and packages/grading-engine/src/descriptive.ts.
 */

/** One step of a grade's descriptor scale, as the API shows it. */
export interface DescriptorView {
  id: string;
  position: number;
  label: string;
  points: number | null;
  not_achieved: boolean;
}

/** The engine's descriptors (highest first) as API views. */
export function descriptorViews(descriptors: readonly EngineDescriptor[]): DescriptorView[] {
  return descriptors.map((descriptor, index) => ({
    id: descriptor.id,
    position: index + 1,
    label: descriptor.label,
    points: descriptor.points,
    not_achieved: descriptor.notAchieved,
  }));
}

export interface DescriptorInput {
  /** An existing descriptor to keep (marks that use it stay attached); omitted for a new one. */
  id?: string;
  label: string;
  points: number | null;
  not_achieved: boolean;
}

/** The scale a grade starts with the first time one of its subjects is made descriptive. */
const DEFAULT_DESCRIPTORS: Record<"en" | "ar", { label: string; points: number }[]> = {
  en: [
    { label: "Excellent", points: 4 },
    { label: "Very good", points: 3 },
    { label: "Good", points: 2 },
    { label: "Needs improvement", points: 1 },
  ],
  ar: [
    { label: "ممتاز", points: 4 },
    { label: "جيد جدًا", points: 3 },
    { label: "جيد", points: 2 },
    { label: "يحتاج إلى تحسين", points: 1 },
  ],
};

/** Every grade's descriptor scale for a year, keyed by grade level id. */
export async function loadProgramDescriptorViews(
  tx: TransactionSql,
  schoolId: string,
  yearId: string,
): Promise<Map<string, DescriptorView[]>> {
  const rows = await loadDescriptorRows(tx, schoolId, yearId);
  const byGrade = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byGrade.get(row.grade_level_id) ?? [];
    list.push(row);
    byGrade.set(row.grade_level_id, list);
  }
  return new Map(
    [...byGrade].map(([grade, list]) => [grade, descriptorViews(toEngineDescriptors(list))]),
  );
}

function badScale(message: string): never {
  throw new CodedHttpException(400, ERROR_CODES.VALIDATION_FAILED, message);
}

/**
 * Replace a grade's descriptor scale with `input` (highest first). Kept descriptors are updated in
 * place so the marks that chose them stay attached; one that marks use cannot be removed.
 */
export async function replaceDescriptors(
  tx: TransactionSql,
  schoolId: string,
  program: Pick<ProgramRow, "id" | "academic_year_id" | "grade_level_id">,
  input: readonly DescriptorInput[],
): Promise<void> {
  if (input.length === 1) badScale("A descriptor scale needs at least two descriptors.");
  const labels = new Set<string>();
  for (const descriptor of input) {
    const key = descriptor.label.trim().toLowerCase();
    if (labels.has(key)) badScale(`Two descriptors are named "${descriptor.label}".`);
    labels.add(key);
  }
  const withPoints = input.filter((descriptor) => descriptor.points !== null).length;
  if (withPoints > 0 && withPoints < input.length) {
    badScale("Give every descriptor points, or none.");
  }

  const existing = await loadDescriptorRows(tx, schoolId, program.academic_year_id, [
    program.grade_level_id,
  ]);
  const existingIds = new Set(existing.map((row) => row.id));
  for (const descriptor of input) {
    if (descriptor.id && !existingIds.has(descriptor.id)) {
      badScale("A descriptor to keep is not part of this grade's scale.");
    }
  }
  const keep = new Set(input.flatMap((descriptor) => (descriptor.id ? [descriptor.id] : [])));
  const removed = existing.filter((row) => !keep.has(row.id)).map((row) => row.id);

  if (removed.length > 0) {
    try {
      await tx.savepoint(
        (sp) => sp`
          DELETE FROM app.grade_program_descriptors
          WHERE school_id = ${schoolId}::uuid AND id = ANY (${removed}::uuid[])
        `,
      );
    } catch (error) {
      if ((error as { code?: string }).code === "23503") {
        throw new CodedHttpException(
          409,
          ERROR_CODES.CONFLICT_STATE_MISMATCH,
          "A descriptor that teachers have already used cannot be removed; rename it instead.",
        );
      }
      throw error;
    }
  }

  // Positions are unique per grade (deferred to commit), so kept rows can swap places freely.
  for (const [index, descriptor] of input.entries()) {
    const label = descriptor.label.trim();
    if (descriptor.id) {
      await tx`
        UPDATE app.grade_program_descriptors SET
          position = ${index + 1}, label = ${label}, points = ${descriptor.points},
          not_achieved = ${descriptor.not_achieved}, updated_at = CURRENT_TIMESTAMP
        WHERE id = ${descriptor.id}::uuid AND school_id = ${schoolId}::uuid
      `;
    } else {
      await tx`
        INSERT INTO app.grade_program_descriptors (
          school_id, academic_year_id, grade_level_id, position, label, points, not_achieved
        ) VALUES (
          ${schoolId}::uuid, ${program.academic_year_id}::uuid, ${program.grade_level_id}::uuid,
          ${index + 1}, ${label}, ${descriptor.points}, ${descriptor.not_achieved}
        )
      `;
    }
  }

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "grade_program_descriptors",
    targetId: program.id,
    oldValues: {
      descriptors: existing.map((row) => ({
        id: row.id,
        label: row.label,
        points: row.points,
        not_achieved: row.not_achieved,
      })),
    },
    newValues: { descriptors: input },
  });
}

/**
 * Give a grade the default descriptor scale (in the school's language) if it has none yet, so a
 * subject made descriptive is usable straight away. The school can rename or replace it.
 */
export async function ensureDefaultDescriptors(
  tx: TransactionSql,
  schoolId: string,
  program: Pick<ProgramRow, "id" | "academic_year_id" | "grade_level_id">,
): Promise<void> {
  const existing = await loadDescriptorRows(tx, schoolId, program.academic_year_id, [
    program.grade_level_id,
  ]);
  if (existing.length > 0) return;
  const [settings] = await tx<{ locale: string | null }[]>`
    SELECT locale FROM app.school_settings WHERE school_id = ${schoolId}::uuid
  `;
  const defaults = (settings?.locale ?? "en").toLowerCase().startsWith("ar")
    ? DEFAULT_DESCRIPTORS.ar
    : DEFAULT_DESCRIPTORS.en;
  await replaceDescriptors(
    tx,
    schoolId,
    program,
    defaults.map((descriptor) => ({ ...descriptor, not_achieved: false })),
  );
}

/**
 * A descriptive subject has no marks, weights, pass mark or retakes, and never counts in the
 * numeric average: whatever the client sent for those is replaced by the fixed values, so the
 * stored row always says exactly what the engine does.
 */
export function normalizeDescriptiveInput(input: SubjectConfigInput): SubjectConfigInput {
  if (input.grading_method !== "descriptive") return input;
  return {
    ...input,
    include_in_average: false,
    final_exam_pass_percentage: null,
    retake_policy: "none",
    retake_cap_percentage: null,
    term_weights: [],
    categories: input.categories.map((category) => ({
      ...category,
      weight: null,
      aggregation: "weighted_average",
      drop_lowest: 0,
    })),
    assessments: input.assessments.map((assessment) => ({ ...assessment, max_marks: 1 })),
  };
}
