import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../coded-http-exception";
import { emitAuditLog } from "../../middleware/auditEmitter";

import type { TransactionSql } from "postgres";

/**
 * Academic planning settings (000268): the outcome achievement scale, whether outcome achievement
 * is shown on report cards (off by default), and when lesson and term plans are due.
 *
 * No settings row means the defaults; no scale rows means {@link DEFAULT_ACHIEVEMENT_LEVELS}. This
 * file reads nothing from the grading module, so finalization can import it without a cycle.
 */

export interface AchievementLevel {
  /** 1 = the lowest. */
  level: number;
  label: string;
  label_ar: string | null;
}

export interface PlanningSettings {
  show_outcomes_on_report_cards: boolean;
  /** A lesson plan is on time when submitted at least this many days before the lesson. */
  lesson_plan_lead_days: number;
  /** A term plan is on time when submitted by the term's first day plus this many days. */
  term_plan_due_days: number;
  achievement_levels: AchievementLevel[];
  /** True while the school has saved no scale of its own and gets the default four. */
  achievement_levels_default: boolean;
}

export const DEFAULT_ACHIEVEMENT_LEVELS: readonly AchievementLevel[] = [
  { level: 1, label: "Beginning", label_ar: "مبتدئ" },
  { level: 2, label: "Developing", label_ar: "في طور النمو" },
  { level: 3, label: "Meeting", label_ar: "متحقق" },
  { level: 4, label: "Exceeding", label_ar: "متجاوز للتوقعات" },
];

export const DEFAULT_PLANNING = {
  show_outcomes_on_report_cards: false,
  lesson_plan_lead_days: 1,
  term_plan_due_days: 7,
} as const;

export const ACHIEVEMENT_LEVELS_MIN = 2;
export const ACHIEVEMENT_LEVELS_MAX = 10;

/** One round trip: the settings row (if any) and the scale (if any). */
export async function getPlanningSettings(
  tx: TransactionSql,
  schoolId: string,
): Promise<PlanningSettings> {
  const [row] = await tx<
    {
      show_outcomes_on_report_cards: boolean | null;
      lesson_plan_lead_days: number | null;
      term_plan_due_days: number | null;
      levels: AchievementLevel[];
    }[]
  >`
    SELECT settings.show_outcomes_on_report_cards, settings.lesson_plan_lead_days,
           settings.term_plan_due_days,
           (
             SELECT coalesce(
               json_agg(
                 json_build_object('level', scale.level, 'label', scale.label,
                                   'label_ar', scale.label_ar)
                 ORDER BY scale.level
               ),
               '[]'::json
             )
             FROM app.outcome_achievement_levels AS scale
             WHERE scale.school_id = ${schoolId}::uuid
           ) AS levels
    FROM (SELECT 1) AS one
    LEFT JOIN app.academic_planning_settings AS settings ON settings.school_id = ${schoolId}::uuid
  `;
  const levels = row?.levels ?? [];
  return {
    show_outcomes_on_report_cards:
      row?.show_outcomes_on_report_cards ?? DEFAULT_PLANNING.show_outcomes_on_report_cards,
    lesson_plan_lead_days: row?.lesson_plan_lead_days ?? DEFAULT_PLANNING.lesson_plan_lead_days,
    term_plan_due_days: row?.term_plan_due_days ?? DEFAULT_PLANNING.term_plan_due_days,
    achievement_levels:
      levels.length > 0 ? levels : DEFAULT_ACHIEVEMENT_LEVELS.map((level) => ({ ...level })),
    achievement_levels_default: levels.length === 0,
  };
}

export interface UpdatePlanningSettingsInput {
  show_outcomes_on_report_cards?: boolean;
  lesson_plan_lead_days?: number;
  term_plan_due_days?: number;
  /** The whole scale, lowest first; levels are numbered 1..n in this order. */
  achievement_levels?: { label: string; label_ar?: string | null }[];
}

function clean(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export async function updatePlanningSettings(
  tx: TransactionSql,
  schoolId: string,
  input: UpdatePlanningSettingsInput,
): Promise<PlanningSettings> {
  const before = await getPlanningSettings(tx, schoolId);
  const next = {
    show_outcomes_on_report_cards:
      input.show_outcomes_on_report_cards ?? before.show_outcomes_on_report_cards,
    lesson_plan_lead_days: input.lesson_plan_lead_days ?? before.lesson_plan_lead_days,
    term_plan_due_days: input.term_plan_due_days ?? before.term_plan_due_days,
  };
  await tx`
    INSERT INTO app.academic_planning_settings (
      school_id, show_outcomes_on_report_cards, lesson_plan_lead_days, term_plan_due_days
    ) VALUES (
      ${schoolId}::uuid, ${next.show_outcomes_on_report_cards}, ${next.lesson_plan_lead_days},
      ${next.term_plan_due_days}
    )
    ON CONFLICT (school_id) DO UPDATE
      SET show_outcomes_on_report_cards = EXCLUDED.show_outcomes_on_report_cards,
          lesson_plan_lead_days = EXCLUDED.lesson_plan_lead_days,
          term_plan_due_days = EXCLUDED.term_plan_due_days,
          updated_at = GREATEST(CURRENT_TIMESTAMP, app.academic_planning_settings.created_at)
  `;

  let levels = before.achievement_levels;
  if (input.achievement_levels !== undefined) {
    levels = input.achievement_levels.map((level, index) => ({
      level: index + 1,
      label: level.label.trim(),
      label_ar: clean(level.label_ar),
    }));
    if (levels.length < ACHIEVEMENT_LEVELS_MIN || levels.length > ACHIEVEMENT_LEVELS_MAX) {
      throw new CodedHttpException(
        400,
        ERROR_CODES.VALIDATION_FAILED,
        `The scale needs ${ACHIEVEMENT_LEVELS_MIN} to ${ACHIEVEMENT_LEVELS_MAX} levels`,
      );
    }
    if (levels.some((level) => level.label === "")) {
      throw new CodedHttpException(400, ERROR_CODES.VALIDATION_FAILED, "Every level needs a label");
    }
    // A level some student already holds must stay on the scale.
    const [used] = await tx<{ highest: number | null }[]>`
      SELECT max(level)::int AS highest FROM app.student_outcome_achievements
      WHERE school_id = ${schoolId}::uuid
    `;
    if (used?.highest !== null && used?.highest !== undefined && used.highest > levels.length) {
      throw new CodedHttpException(
        409,
        ERROR_CODES.CONFLICT_STATE_MISMATCH,
        `Students already hold level ${used.highest}; the scale must keep at least ${used.highest} levels`,
      );
    }
    await tx`DELETE FROM app.outcome_achievement_levels WHERE school_id = ${schoolId}::uuid`;
    await tx`
      INSERT INTO app.outcome_achievement_levels (school_id, level, label, label_ar)
      SELECT ${schoolId}::uuid, x.level, x.label, x.label_ar
      FROM jsonb_to_recordset(${tx.json(levels as never)}::jsonb)
        AS x(level smallint, label text, label_ar text)
    `;
  }

  const after: PlanningSettings = {
    ...next,
    achievement_levels: levels,
    achievement_levels_default:
      input.achievement_levels === undefined ? before.achievement_levels_default : false,
  };
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "academic_planning_settings",
    targetId: schoolId,
    oldValues: { ...before },
    newValues: { ...after },
  });
  return after;
}

/** The label of `level` on the scale, or null when the scale no longer has it. */
export function levelOf(
  levels: readonly AchievementLevel[],
  level: number,
): AchievementLevel | null {
  return levels.find((candidate) => candidate.level === level) ?? null;
}
