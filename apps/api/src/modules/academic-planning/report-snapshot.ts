import { getPlanningSettings } from "./settings-service";

import type { TransactionSql } from "postgres";

/**
 * Learning outcome achievement on report cards (000267, ADR-017).
 *
 * When the school shows outcomes on report cards, finalizing a section's period (and every
 * correction, which writes a new finalization version) copies the period's achievement into the
 * append-only app.finalized_outcome_achievements: the outcome's code, text and strand and the
 * level's labels as they are at that moment. Report cards, certificates and the student and parent
 * results views read that snapshot only, so a later catalogue or scale edit never rewrites them.
 * With the setting off nothing is copied, and results read exactly as before.
 */

export interface OutcomeAchievementView {
  outcome_id: string;
  code: string;
  text: string;
  text_ar: string | null;
  strand: string | null;
  level: number;
  /** The level's label as finalized; null when the scale had no such level. */
  label: string | null;
  label_ar: string | null;
}

/** Copy one finalization's outcome achievement; a no-op while the school does not show it. */
export async function snapshotOutcomeAchievements(
  tx: TransactionSql,
  schoolId: string,
  finalization: { id: string; section_id: string; term_id: string | null },
): Promise<void> {
  const settings = await getPlanningSettings(tx, schoolId);
  if (!settings.show_outcomes_on_report_cards) return;
  // Only subjects the student has a finalized result in (the snapshot's foreign key).
  await tx`
    WITH scale AS (
      SELECT level, label, label_ar
      FROM jsonb_to_recordset(${tx.json(settings.achievement_levels as never)}::jsonb)
        AS x(level smallint, label text, label_ar text)
    )
    INSERT INTO app.finalized_outcome_achievements (
      school_id, finalization_id, student_id, subject_id, outcome_id, code, text, text_ar, strand,
      sort_order, level, label, label_ar
    )
    SELECT ${schoolId}::uuid, ${finalization.id}::uuid, achievement.student_id,
           achievement.subject_id, outcome.id, outcome.code, outcome.text, outcome.text_ar,
           outcome.strand, outcome.sort_order, achievement.level, scale.label, scale.label_ar
    FROM app.student_outcome_achievements AS achievement
    JOIN app.learning_outcomes AS outcome
      ON outcome.id = achievement.outcome_id AND outcome.school_id = achievement.school_id
    JOIN app.student_subject_results AS result
      ON result.school_id = achievement.school_id
     AND result.finalization_id = ${finalization.id}::uuid
     AND result.student_id = achievement.student_id
     AND result.subject_id = achievement.subject_id
    LEFT JOIN scale ON scale.level = achievement.level
    WHERE achievement.school_id = ${schoolId}::uuid
      AND achievement.section_id = ${finalization.section_id}::uuid
      AND achievement.term_id IS NOT DISTINCT FROM ${finalization.term_id}::uuid
  `;
}

/**
 * The snapshot for one finalization, keyed by `student_id|subject_id`, each list in catalogue order.
 * Finalizations without a snapshot (the setting was off, or made before 000267) have none.
 */
export async function readOutcomeSnapshot(
  tx: TransactionSql,
  schoolId: string,
  finalizationId: string,
  studentId?: string,
): Promise<Map<string, OutcomeAchievementView[]>> {
  const studentFilter = studentId ? tx`AND student_id = ${studentId}::uuid` : tx``;
  const rows = await tx<(OutcomeAchievementView & { student_id: string; subject_id: string })[]>`
    SELECT student_id, subject_id, outcome_id, code, text, text_ar, strand, level, label, label_ar
    FROM app.finalized_outcome_achievements
    WHERE school_id = ${schoolId}::uuid AND finalization_id = ${finalizationId}::uuid
      ${studentFilter}
    ORDER BY sort_order, code
  `;
  const out = new Map<string, OutcomeAchievementView[]>();
  for (const { student_id, subject_id, ...view } of rows) {
    const key = `${student_id}|${subject_id}`;
    const list = out.get(key) ?? [];
    list.push(view);
    out.set(key, list);
  }
  return out;
}
