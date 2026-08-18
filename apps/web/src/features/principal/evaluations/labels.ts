import type { Evaluation, EvaluationStatus } from "./queries";

export type EvaluationType = Evaluation["evaluation_type"];
export type EvaluationRating = NonNullable<Evaluation["rating"]>;

export const EVALUATION_TYPE_LABELS: Record<EvaluationType, string> = {
  formal_observation: "Formal observation",
  peer_review: "Peer review",
  self_assessment: "Self-assessment",
  student_feedback: "Student feedback",
  annual_review: "Annual review",
  probationary_review: "Probationary review",
};

export const EVALUATION_STATUS_LABELS: Record<EvaluationStatus, string> = {
  draft: "Draft",
  submitted: "Submitted",
  finalized: "Finalized",
};

export const EVALUATION_RATING_LABELS: Record<EvaluationRating, string> = {
  unsatisfactory: "Unsatisfactory",
  developing: "Developing",
  proficient: "Proficient",
  exemplary: "Exemplary",
};

/** `evaluations-rating-pill` tone for a rating. */
export function ratingTone(rating: EvaluationRating): "success" | "warning" | "danger" {
  if (rating === "exemplary" || rating === "proficient") return "success";
  if (rating === "developing") return "warning";
  return "danger";
}
