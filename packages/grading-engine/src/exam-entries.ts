/**
 * Exam entries (docs/modules/exam-entries.md): the rules for entering students for a session of an
 * external exam, shared by the API and the web form.
 *
 * An entry moves `draft` → `entered` → `withdrawn`; a withdrawn entry can be reinstated as
 * `entered`. A draft is never withdrawn (it was never sent to the board: delete it instead) and an
 * entry never goes back to draft.
 */

export const EXAM_ENTRY_STATUSES = ["draft", "entered", "withdrawn"] as const;
export type ExamEntryStatus = (typeof EXAM_ENTRY_STATUSES)[number];

export const EXAM_ENTRY_LIMITS = {
  seriesLength: 120,
  noteLength: 1000,
  candidateNumberLength: 20,
  tierLength: 40,
  optionCodeLength: 40,
  /** Subjects one entry may cover. */
  maxSubjects: 30,
  /** Students or entries one bulk request may name. */
  maxBatch: 1000,
  /** Digits a generated candidate number is padded to, at most. */
  maxNumberWidth: 10,
  candidatePrefixLength: 10,
} as const;

const TRANSITIONS: ReadonlyMap<ExamEntryStatus, readonly ExamEntryStatus[]> = new Map([
  ["draft", ["entered"]],
  ["entered", ["withdrawn"]],
  ["withdrawn", ["entered"]],
]);

/** Whether an entry in `from` may be moved to `to`. Staying in the same status is not a change. */
export function canChangeExamEntryStatus(from: ExamEntryStatus, to: ExamEntryStatus): boolean {
  return TRANSITIONS.get(from)?.includes(to) ?? false;
}

export interface CandidateNumberPlan {
  /** First number to try; numbers already in use are skipped. */
  start: number;
  /** Digits to zero-pad to (4 turns 7 into "0007"); 0 or 1 means no padding. */
  width: number;
  /** Text before the digits ("" or a centre prefix such as "JO123-"). */
  prefix: string;
}

/**
 * Candidate numbers for `count` entries, in order: `prefix` + the next number from `start`
 * zero-padded to `width`, skipping any already in `used` (compared case-insensitively, as the
 * database's unique index does).
 */
export function nextCandidateNumbers(
  count: number,
  plan: CandidateNumberPlan,
  used: Iterable<string>,
): string[] {
  const taken = new Set([...used].map((value) => value.toLowerCase()));
  const out: string[] = [];
  let next = Math.max(0, Math.trunc(plan.start));
  while (out.length < count) {
    const candidate = `${plan.prefix}${String(next).padStart(Math.max(plan.width, 1), "0")}`;
    next += 1;
    if (taken.has(candidate.toLowerCase())) continue;
    taken.add(candidate.toLowerCase());
    out.push(candidate);
  }
  return out;
}
