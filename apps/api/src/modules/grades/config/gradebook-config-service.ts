import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { emitAuditLog } from "../../../middleware/auditEmitter";

import type {
  CreateCategoryBody,
  GradeBoundary,
  GradingSchemeType,
  UpdateCategoryBody,
} from "./schemas";
import type { TransactionSql } from "postgres";

/**
 * Gradebook configuration persistence and authorization (ST-112).
 *
 * ## Authorization model
 *
 * Three layers, same as the assignment module:
 *
 * 1. `tenant_isolation` (000006) pins every row to app.school_id.
 * 2. `role_scope_visibility` on gradebook-adjacent tables restricts reads.
 * 3. This module enforces write authorization via `assertCanManageGradebook`, which delegates
 *    to `app.teaches_class()` and `app.current_user_is_school_admin()` — the same SECURITY
 *    DEFINER helpers the RLS policies call.
 *
 * ## Weight validation
 *
 * The total of all active category weights must equal exactly 100%. Float tolerance of 0.001
 * handles rounding drift (e.g. 33.33 + 33.33 + 33.34 = 100.00).
 *
 * ## Grading scheme versioning
 *
 * `app.grading_schemes` is append-only for `studafy_app` (only SELECT + INSERT granted).
 * Prior versions are structurally immutable. New versions auto-increment the version number
 * per term.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AssessmentCategoryRow {
  id: string;
  school_id: string;
  gradebook_id: string;
  name: string;
  weight: string;
  description: string | null;
  sort_order: number;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface GradebookRow {
  id: string;
  school_id: string;
  class_id: string;
  status: string;
  grading_scheme_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface GradingSchemeRow {
  id: string;
  school_id: string;
  term_id: string;
  academic_year_id: string;
  version: number;
  name: string;
  scheme_type: string;
  grade_boundaries: unknown;
  is_inherited: boolean;
  created_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface SchoolSettingsRow {
  grading_scheme: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WEIGHT_TOLERANCE = 0.001;

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

/**
 * Refuse unless the caller may manage gradebook configuration for this class.
 *
 * Delegates to the same SECURITY DEFINER helpers the RLS policies call:
 * `app.teaches_class(classId)` covers lead teachers and timetable-slot holders;
 * `app.current_user_is_school_admin()` covers ORG_ADMIN and SUPER_ADMIN.
 */
export async function assertCanManageGradebook(tx: TransactionSql, classId: string): Promise<void> {
  const [row] = await tx<{ allowed: boolean }[]>`
    SELECT (app.current_user_is_school_admin() OR app.teaches_class(${classId})) AS allowed
  `;

  if (!row?.allowed) {
    throw new CodedHttpException(
      403,
      ERROR_CODES.AUTHZ_FORBIDDEN,
      "You are not assigned to this class",
    );
  }
}

// ---------------------------------------------------------------------------
// Gradebook lookup
// ---------------------------------------------------------------------------

/**
 * Resolve a gradebook by class ID. Creates a draft gradebook if none exists (lazy init).
 */
export async function getGradebookByClassId(
  tx: TransactionSql,
  schoolId: string,
  classId: string,
): Promise<GradebookRow> {
  const [existing] = await tx<GradebookRow[]>`
    SELECT id, school_id, class_id, status, grading_scheme_id, created_at, updated_at
    FROM app.gradebooks
    WHERE school_id = ${schoolId}::uuid AND class_id = ${classId}::uuid
  `;

  if (existing) return existing;

  const [created] = await tx<GradebookRow[]>`
    INSERT INTO app.gradebooks (school_id, class_id, status)
    VALUES (${schoolId}::uuid, ${classId}::uuid, 'draft'::app.gradebook_status)
    RETURNING id, school_id, class_id, status, grading_scheme_id, created_at, updated_at
  `;

  return created!;
}

/**
 * Resolve a gradebook by its own ID, verifying it belongs to the school.
 */
export async function getGradebookById(
  tx: TransactionSql,
  schoolId: string,
  gradebookId: string,
): Promise<GradebookRow> {
  const [row] = await tx<GradebookRow[]>`
    SELECT id, school_id, class_id, status, grading_scheme_id, created_at, updated_at
    FROM app.gradebooks
    WHERE id = ${gradebookId}::uuid AND school_id = ${schoolId}::uuid
  `;

  if (!row) {
    throw new CodedHttpException(404, ERROR_CODES.GRADEBOOK_NOT_FOUND, "Gradebook not found");
  }

  return row;
}

// ---------------------------------------------------------------------------
// Weight validation
// ---------------------------------------------------------------------------

/**
 * Validate that the sum of all active category weights equals exactly 100%.
 * Uses a float tolerance to handle rounding (e.g. 33.33 + 33.33 + 33.34 = 100.00).
 */
export async function validateWeightTotal(
  tx: TransactionSql,
  gradebookId: string,
  schoolId: string,
): Promise<number> {
  const [result] = await tx<{ total: string | null }[]>`
    SELECT COALESCE(SUM(weight), 0)::text AS total
    FROM app.assessment_categories
    WHERE gradebook_id = ${gradebookId}::uuid
      AND school_id = ${schoolId}::uuid
      AND is_active = true
  `;

  const total = Number(result?.total ?? 0);

  if (Math.abs(total - 100) > WEIGHT_TOLERANCE) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.INVALID_GRADEBOOK_WEIGHT_TOTAL,
      `Assessment category weights must sum to 100%. Current total: ${total}%`,
    );
  }

  return total;
}

// ---------------------------------------------------------------------------
// Assessment categories — CRUD
// ---------------------------------------------------------------------------

/**
 * List all categories for a gradebook, ordered by sort_order.
 */
export async function listCategories(
  tx: TransactionSql,
  schoolId: string,
  gradebookId: string,
): Promise<{ categories: AssessmentCategoryRow[]; totalWeight: number }> {
  const categories = await tx<AssessmentCategoryRow[]>`
    SELECT id, school_id, gradebook_id, name, weight, description, sort_order, is_active,
           created_at, updated_at
    FROM app.assessment_categories
    WHERE school_id = ${schoolId}::uuid AND gradebook_id = ${gradebookId}::uuid
    ORDER BY sort_order ASC, created_at ASC
  `;

  const totalWeight = categories
    .filter((c) => c.is_active)
    .reduce((sum, c) => sum + Number(c.weight), 0);

  return { categories, totalWeight };
}

/**
 * Create a new assessment category for a gradebook.
 * Validates weight total after insertion.
 */
export async function createCategory(
  tx: TransactionSql,
  schoolId: string,
  gradebookId: string,
  params: CreateCategoryBody,
): Promise<AssessmentCategoryRow> {
  const [row] = await tx<AssessmentCategoryRow[]>`
    INSERT INTO app.assessment_categories
      (school_id, gradebook_id, name, weight, description, sort_order, is_active)
    VALUES (
      ${schoolId}::uuid,
      ${gradebookId}::uuid,
      ${params.name},
      ${params.weight}::numeric(5,2),
      ${params.description ?? null},
      ${params.sort_order ?? 0},
      ${params.is_active ?? true}
    )
    RETURNING id, school_id, gradebook_id, name, weight, description, sort_order, is_active,
              created_at, updated_at
  `;

  // Validate after insertion — if the total is off, the INSERT rolls back with the tx.
  await validateWeightTotal(tx, gradebookId, schoolId);

  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "assessment_categories",
    targetId: row!.id,
    newValues: auditableFields(row!),
  });

  return row!;
}

/**
 * Update an existing assessment category.
 * Validates weight total after update.
 */
export async function updateCategory(
  tx: TransactionSql,
  schoolId: string,
  gradebookId: string,
  categoryId: string,
  params: UpdateCategoryBody,
): Promise<AssessmentCategoryRow> {
  // Load existing for audit diff.
  const [existing] = await tx<AssessmentCategoryRow[]>`
    SELECT id, school_id, gradebook_id, name, weight, description, sort_order, is_active,
           created_at, updated_at
    FROM app.assessment_categories
    WHERE id = ${categoryId}::uuid
      AND school_id = ${schoolId}::uuid
      AND gradebook_id = ${gradebookId}::uuid
  `;

  if (!existing) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.ASSESSMENT_CATEGORY_NOT_FOUND,
      "Assessment category not found",
    );
  }

  const [updated] = await tx<AssessmentCategoryRow[]>`
    UPDATE app.assessment_categories SET
      name        = COALESCE(${params.name ?? null}, name),
      weight      = COALESCE(${params.weight != null ? String(params.weight) : null}::numeric(5,2), weight),
      description = COALESCE(${params.description ?? null}, description),
      sort_order  = COALESCE(${params.sort_order != null ? String(params.sort_order) : null}::integer, sort_order),
      is_active   = COALESCE(${params.is_active != null ? String(params.is_active) : null}::boolean, is_active),
      updated_at  = CURRENT_TIMESTAMP
    WHERE id = ${categoryId}::uuid
      AND school_id = ${schoolId}::uuid
      AND gradebook_id = ${gradebookId}::uuid
    RETURNING id, school_id, gradebook_id, name, weight, description, sort_order, is_active,
              created_at, updated_at
  `;

  if (!updated) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.ASSESSMENT_CATEGORY_NOT_FOUND,
      "Assessment category not found",
    );
  }

  // Validate after update — if the total is off, the UPDATE rolls back with the tx.
  await validateWeightTotal(tx, gradebookId, schoolId);

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "assessment_categories",
    targetId: categoryId,
    oldValues: auditableFields(existing),
    newValues: auditableFields(updated),
  });

  return updated;
}

/**
 * Delete an assessment category.
 * Validates weight total after deletion.
 */
export async function deleteCategory(
  tx: TransactionSql,
  schoolId: string,
  gradebookId: string,
  categoryId: string,
): Promise<void> {
  const [existing] = await tx<AssessmentCategoryRow[]>`
    SELECT id, school_id, gradebook_id, name, weight, description, sort_order, is_active,
           created_at, updated_at
    FROM app.assessment_categories
    WHERE id = ${categoryId}::uuid
      AND school_id = ${schoolId}::uuid
      AND gradebook_id = ${gradebookId}::uuid
  `;

  if (!existing) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.ASSESSMENT_CATEGORY_NOT_FOUND,
      "Assessment category not found",
    );
  }

  await tx`DELETE FROM app.assessment_categories WHERE id = ${categoryId}::uuid`;

  // Validate after deletion — if the total is off, the DELETE rolls back with the tx.
  await validateWeightTotal(tx, gradebookId, schoolId);

  await emitAuditLog(tx, {
    action: "delete",
    targetTable: "assessment_categories",
    targetId: categoryId,
    oldValues: auditableFields(existing),
  });
}

// ---------------------------------------------------------------------------
// Grading schemes — versioned, append-only
// ---------------------------------------------------------------------------

/**
 * Default grade boundaries per scheme type, derived from school_settings.grading_scheme.
 */
export function getDefaultBoundaries(schemeType: GradingSchemeType): GradeBoundary[] {
  switch (schemeType) {
    case "letter":
      return [
        { label: "A", min: 90, max: 100, gpa_points: 4.0 },
        { label: "B", min: 80, max: 89, gpa_points: 3.0 },
        { label: "C", min: 70, max: 79, gpa_points: 2.0 },
        { label: "D", min: 60, max: 69, gpa_points: 1.0 },
        { label: "F", min: 0, max: 59, gpa_points: 0.0 },
      ];
    case "gpa":
      return [
        { label: "A", min: 90, max: 100, gpa_points: 4.0 },
        { label: "B", min: 80, max: 89, gpa_points: 3.0 },
        { label: "C", min: 70, max: 79, gpa_points: 2.0 },
        { label: "D", min: 60, max: 69, gpa_points: 1.0 },
        { label: "F", min: 0, max: 59, gpa_points: 0.0 },
      ];
    case "percentage":
      return [
        { label: "Excellent", min: 90, max: 100 },
        { label: "Good", min: 80, max: 89 },
        { label: "Average", min: 70, max: 79 },
        { label: "Below Average", min: 60, max: 69 },
        { label: "Failing", min: 0, max: 59 },
      ];
    case "numeric":
      return [
        { label: "5", min: 90, max: 100 },
        { label: "4", min: 80, max: 89 },
        { label: "3", min: 70, max: 79 },
        { label: "2", min: 60, max: 69 },
        { label: "1", min: 0, max: 59 },
      ];
    case "pass_fail":
      return [
        { label: "Pass", min: 60, max: 100 },
        { label: "Fail", min: 0, max: 59 },
      ];
  }
}

/**
 * Read the school's grading_scheme type from school_settings and return default boundaries.
 * Creates the settings row if it does not exist (lazy init, same as tenancy/settings/service).
 */
export async function getInheritedSchemeBoundaries(
  tx: TransactionSql,
  schoolId: string,
): Promise<{ schemeType: GradingSchemeType; boundaries: GradeBoundary[] }> {
  const [settings] = await tx<SchoolSettingsRow[]>`
    SELECT grading_scheme FROM app.school_settings WHERE school_id = ${schoolId}::uuid
  `;

  const schemeType = (settings?.grading_scheme ?? "letter") as GradingSchemeType;
  return { schemeType, boundaries: getDefaultBoundaries(schemeType) };
}

/**
 * List all versions of grading schemes for a term.
 */
export async function listSchemes(
  tx: TransactionSql,
  schoolId: string,
  termId: string,
): Promise<GradingSchemeRow[]> {
  return tx<GradingSchemeRow[]>`
    SELECT
      scheme.id,
      scheme.school_id,
      scheme.term_id,
      scheme.academic_year_id,
      scheme.version,
      scheme.name,
      scheme.scheme_type,
      COALESCE(
        (
          SELECT jsonb_agg(
            jsonb_build_object(
              'label', boundary.label,
              'min', boundary.min_percentage,
              'max', boundary.max_percentage,
              'gpa_points', boundary.gpa_points
            )
            ORDER BY boundary.position
          )
          FROM app.grading_scheme_boundaries AS boundary
          WHERE boundary.school_id = scheme.school_id
            AND boundary.grading_scheme_id = scheme.id
        ),
        '[]'::jsonb
      ) AS grade_boundaries,
      scheme.is_inherited,
      scheme.created_by_user_id,
      scheme.created_at,
      scheme.updated_at
    FROM app.grading_schemes AS scheme
    WHERE scheme.school_id = ${schoolId}::uuid AND scheme.term_id = ${termId}::uuid
    ORDER BY scheme.version DESC
  `;
}

/**
 * Get a specific grading scheme by ID.
 */
export async function getScheme(
  tx: TransactionSql,
  schoolId: string,
  schemeId: string,
): Promise<GradingSchemeRow> {
  const [row] = await tx<GradingSchemeRow[]>`
    SELECT
      scheme.id,
      scheme.school_id,
      scheme.term_id,
      scheme.academic_year_id,
      scheme.version,
      scheme.name,
      scheme.scheme_type,
      COALESCE(
        (
          SELECT jsonb_agg(
            jsonb_build_object(
              'label', boundary.label,
              'min', boundary.min_percentage,
              'max', boundary.max_percentage,
              'gpa_points', boundary.gpa_points
            )
            ORDER BY boundary.position
          )
          FROM app.grading_scheme_boundaries AS boundary
          WHERE boundary.school_id = scheme.school_id
            AND boundary.grading_scheme_id = scheme.id
        ),
        '[]'::jsonb
      ) AS grade_boundaries,
      scheme.is_inherited,
      scheme.created_by_user_id,
      scheme.created_at,
      scheme.updated_at
    FROM app.grading_schemes AS scheme
    WHERE scheme.id = ${schemeId}::uuid AND scheme.school_id = ${schoolId}::uuid
  `;

  if (!row) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.GRADING_SCHEME_NOT_FOUND,
      "Grading scheme not found",
    );
  }

  return row;
}

/**
 * Create a new versioned grading scheme for a term.
 * Auto-assigns the next version number. If this is the first scheme for the term,
 * inherits boundaries from school settings and marks is_inherited = true.
 */
export async function createScheme(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  params: {
    term_id: string;
    name: string;
    scheme_type: GradingSchemeType;
    grade_boundaries: GradeBoundary[];
  },
): Promise<GradingSchemeRow> {
  // Resolve the academic_year_id from the term.
  const [term] = await tx<{ academic_year_id: string }[]>`
    SELECT academic_year_id FROM app.terms
    WHERE id = ${params.term_id}::uuid AND school_id = ${schoolId}::uuid
  `;

  if (!term) {
    throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Term not found");
  }

  // Determine next version number for this term.
  const [maxVersion] = await tx<{ max_version: number | null }[]>`
    SELECT MAX(version) AS max_version
    FROM app.grading_schemes
    WHERE school_id = ${schoolId}::uuid AND term_id = ${params.term_id}::uuid
  `;

  const nextVersion = (maxVersion?.max_version ?? 0) + 1;

  const [row] = await tx<GradingSchemeRow[]>`
    INSERT INTO app.grading_schemes
      (school_id, term_id, academic_year_id, version, name, scheme_type,
       is_inherited, created_by_user_id)
    VALUES (
      ${schoolId}::uuid,
      ${params.term_id}::uuid,
      ${term.academic_year_id}::uuid,
      ${nextVersion},
      ${params.name},
      ${params.scheme_type},
      false,
      ${userId}::uuid
    )
    RETURNING id, school_id, term_id, academic_year_id, version, name, scheme_type,
              '[]'::jsonb AS grade_boundaries, is_inherited, created_by_user_id,
              created_at, updated_at
  `;

  await insertSchemeBoundaries(tx, schoolId, row!.id, params.grade_boundaries);

  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "grading_schemes",
    targetId: row!.id,
    newValues: {
      term_id: params.term_id,
      version: nextVersion,
      name: params.name,
      scheme_type: params.scheme_type,
      grade_boundaries: params.grade_boundaries,
    },
  });

  return { ...row!, grade_boundaries: params.grade_boundaries };
}

/**
 * Get or create an inherited grading scheme for a gradebook's term.
 * If no scheme exists for the term yet, creates version 1 from school defaults.
 * Returns the scheme (existing or newly created).
 */
export async function getOrCreateInheritedScheme(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  termId: string,
): Promise<GradingSchemeRow> {
  const existing = await listSchemes(tx, schoolId, termId);
  if (existing.length > 0) return existing[0]!;

  // Inherit from school defaults.
  const { schemeType, boundaries } = await getInheritedSchemeBoundaries(tx, schoolId);

  // Resolve academic_year_id.
  const [term] = await tx<{ academic_year_id: string }[]>`
    SELECT academic_year_id FROM app.terms
    WHERE id = ${termId}::uuid AND school_id = ${schoolId}::uuid
  `;

  if (!term) {
    throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Term not found");
  }

  const [row] = await tx<GradingSchemeRow[]>`
    INSERT INTO app.grading_schemes
      (school_id, term_id, academic_year_id, version, name, scheme_type,
       is_inherited, created_by_user_id)
    VALUES (
      ${schoolId}::uuid,
      ${termId}::uuid,
      ${term.academic_year_id}::uuid,
      1,
      ${`Inherited ${schemeType} scale`},
      ${scheme_type(schemeType)},
      true,
      ${userId}::uuid
    )
    ON CONFLICT (school_id, term_id, version) DO NOTHING
    RETURNING id, school_id, term_id, academic_year_id, version, name, scheme_type,
              '[]'::jsonb AS grade_boundaries, is_inherited, created_by_user_id,
              created_at, updated_at
  `;

  if (row) {
    await insertSchemeBoundaries(tx, schoolId, row.id, boundaries);

    await emitAuditLog(tx, {
      action: "insert",
      targetTable: "grading_schemes",
      targetId: row.id,
      newValues: {
        term_id: termId,
        version: 1,
        name: row.name,
        scheme_type: row.scheme_type,
        grade_boundaries: boundaries,
        is_inherited: true,
      },
    });
    return { ...row, grade_boundaries: boundaries };
  }

  // Race condition: another request created it. Re-fetch.
  const schemes = await listSchemes(tx, schoolId, termId);
  return schemes[0]!;
}

// ---------------------------------------------------------------------------
// Gradebook config — combined view
// ---------------------------------------------------------------------------

/**
 * Get the full gradebook configuration: categories + linked scheme.
 * Auto-creates an inherited scheme if none is linked.
 */
export async function getGradebookConfig(
  tx: TransactionSql,
  schoolId: string,
  gradebookId: string,
  userId: string,
): Promise<{
  gradebook_id: string;
  categories: AssessmentCategoryRow[];
  total_weight: number;
  grading_scheme: GradingSchemeRow | null;
}> {
  const gradebook = await getGradebookById(tx, schoolId, gradebookId);

  const { categories, totalWeight } = await listCategories(tx, schoolId, gradebookId);

  let scheme: GradingSchemeRow | null = null;

  if (gradebook.grading_scheme_id) {
    scheme = await getScheme(tx, schoolId, gradebook.grading_scheme_id);
  } else {
    // Resolve term from class, then get or create inherited scheme.
    const [classInfo] = await tx<{ term_id: string }[]>`
      SELECT term_id FROM app.classes
      WHERE id = ${gradebook.class_id}::uuid AND school_id = ${schoolId}::uuid
    `;

    if (classInfo) {
      scheme = await getOrCreateInheritedScheme(tx, schoolId, userId, classInfo.term_id);

      // Link the scheme to the gradebook.
      await tx`UPDATE app.gradebooks SET grading_scheme_id = ${scheme.id}::uuid WHERE id = ${gradebookId}::uuid`;
    }
  }

  return {
    gradebook_id: gradebookId,
    categories,
    total_weight: totalWeight,
    grading_scheme: scheme,
  };
}

/**
 * Link a grading scheme to a gradebook.
 */
export async function linkScheme(
  tx: TransactionSql,
  schoolId: string,
  gradebookId: string,
  schemeId: string,
): Promise<void> {
  const gradebook = await getGradebookById(tx, schoolId, gradebookId);
  const scheme = await getScheme(tx, schoolId, schemeId);

  const [published] = await tx<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM app.grade_submissions
      WHERE school_id = ${schoolId}::uuid
        AND gradebook_id = ${gradebookId}::uuid
        AND status = 'published'
    ) AS exists
  `;
  if (published?.exists) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.CONFLICT_STATE_MISMATCH,
      "The grading scheme cannot change after grades have been published",
    );
  }

  // Verify the scheme belongs to the same term as the gradebook's class.
  const [classInfo] = await tx<{ term_id: string }[]>`
    SELECT term_id FROM app.classes
    WHERE id = ${gradebook.class_id}::uuid AND school_id = ${schoolId}::uuid
  `;

  if (classInfo && classInfo.term_id !== scheme.term_id) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.VALIDATION_FAILED,
      "Grading scheme does not belong to the gradebook's academic term",
    );
  }

  const oldSchemeId = gradebook.grading_scheme_id;

  await tx`UPDATE app.gradebooks SET grading_scheme_id = ${schemeId}::uuid WHERE id = ${gradebookId}::uuid`;

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "gradebooks",
    targetId: gradebookId,
    oldValues: { grading_scheme_id: oldSchemeId },
    newValues: { grading_scheme_id: schemeId },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function auditableFields(row: AssessmentCategoryRow): Record<string, unknown> {
  return {
    name: row.name,
    weight: row.weight,
    description: row.description,
    sort_order: row.sort_order,
    is_active: row.is_active,
  };
}

async function insertSchemeBoundaries(
  tx: TransactionSql,
  schoolId: string,
  schemeId: string,
  boundaries: GradeBoundary[],
): Promise<void> {
  for (const [position, boundary] of boundaries.entries()) {
    await tx`
      INSERT INTO app.grading_scheme_boundaries
        (school_id, grading_scheme_id, position, label, min_percentage, max_percentage, gpa_points)
      VALUES (
        ${schoolId}::uuid,
        ${schemeId}::uuid,
        ${position},
        ${boundary.label},
        ${boundary.min},
        ${boundary.max},
        ${boundary.gpa_points ?? null}
      )
    `;
  }
}

/**
 * Helper to cast GradingSchemeType to a string for SQL template interpolation.
 * Zod enums are not plain strings — we need the `.value` or explicit cast.
 */
function scheme_type(value: string): string {
  return value;
}
