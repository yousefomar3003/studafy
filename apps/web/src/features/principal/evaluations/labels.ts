import type { Evaluation, EvaluationStatus } from "./queries";

export type EvaluationType = Evaluation["evaluation_type"];
export type EvaluationRating = NonNullable<Evaluation["rating"]>;

// Translation keys (not display text) — resolve with `t(...)` at render time.

export const EVALUATION_TYPE_LABEL_KEYS: Record<EvaluationType, string> = {
  formal_observation: "principal.evaluations.type.formal_observation",
  peer_review: "principal.evaluations.type.peer_review",
  self_assessment: "principal.evaluations.type.self_assessment",
  student_feedback: "principal.evaluations.type.student_feedback",
  annual_review: "principal.evaluations.type.annual_review",
  probationary_review: "principal.evaluations.type.probationary_review",
};

export const EVALUATION_STATUS_LABEL_KEYS: Record<EvaluationStatus, string> = {
  draft: "principal.evaluations.status.draft",
  submitted: "principal.evaluations.status.submitted",
  finalized: "principal.evaluations.status.finalized",
};

export const EVALUATION_RATING_LABEL_KEYS: Record<EvaluationRating, string> = {
  unsatisfactory: "principal.evaluations.rating.unsatisfactory",
  developing: "principal.evaluations.rating.developing",
  proficient: "principal.evaluations.rating.proficient",
  exemplary: "principal.evaluations.rating.exemplary",
};

/** `evaluations-rating-pill` tone for a rating. */
export function ratingTone(rating: EvaluationRating): "success" | "warning" | "danger" {
  if (rating === "exemplary" || rating === "proficient") return "success";
  if (rating === "developing") return "warning";
  return "danger";
}
