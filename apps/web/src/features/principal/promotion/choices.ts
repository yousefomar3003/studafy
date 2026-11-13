import type { PromotionDecision, PromotionOutcome, PromotionPreviewStudent } from "./queries";

/** A destination as a select value: "section:<id>", "graduate", "skip", or "" (not chosen yet). */
export type Choice = string;

export const GRADUATE: Choice = "graduate";
export const SKIP: Choice = "skip";

export function sectionChoice(sectionId: string): Choice {
  return `section:${sectionId}`;
}

/** The preview's proposal as a choice. A student needing a decision starts unchosen. */
export function proposedChoice(student: PromotionPreviewStudent): Choice {
  if (student.needs_decision) return "";
  if (student.proposed_action === "graduate") return GRADUATE;
  if (student.proposed_action === "place" && student.proposed_section_id) {
    return sectionChoice(student.proposed_section_id);
  }
  return SKIP;
}

export function toDecision(studentId: string, choice: Choice): PromotionDecision | null {
  if (choice === "") return null;
  if (choice === GRADUATE) return { student_id: studentId, action: "graduate" };
  if (choice === SKIP) return { student_id: studentId, action: "skip" };
  return {
    student_id: studentId,
    action: "place",
    target_section_id: choice.slice("section:".length),
  };
}

export interface PromotionSummary {
  movedUp: number;
  retained: number;
  moved: number;
  graduated: number;
  awaitingResit: number;
  skipped: number;
  alreadyDone: number;
  failed: PromotionOutcome[];
}

/** Counts the outcomes the way the principal reads them; a skip of a resit counts as "awaiting". */
export function summarize(
  outcomes: readonly PromotionOutcome[],
  students: readonly PromotionPreviewStudent[],
): PromotionSummary {
  const reasons = new Map(students.map((student) => [student.student_id, student.reason]));
  const summary: PromotionSummary = {
    movedUp: 0,
    retained: 0,
    moved: 0,
    graduated: 0,
    awaitingResit: 0,
    skipped: 0,
    alreadyDone: 0,
    failed: [],
  };
  for (const outcome of outcomes) {
    switch (outcome.outcome) {
      case "moved_up":
        summary.movedUp += 1;
        break;
      case "retained":
        summary.retained += 1;
        break;
      case "moved":
        summary.moved += 1;
        break;
      case "graduated":
        summary.graduated += 1;
        break;
      case "already_placed":
      case "already_graduated":
        summary.alreadyDone += 1;
        break;
      case "skipped":
        if (reasons.get(outcome.student_id) === "awaiting_resit") summary.awaitingResit += 1;
        else summary.skipped += 1;
        break;
      case "failed":
        summary.failed.push(outcome);
        break;
    }
  }
  return summary;
}
