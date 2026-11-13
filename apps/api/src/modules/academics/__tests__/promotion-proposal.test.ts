/**
 * The destination proposed for each student when moving to the next year (promotion-service's
 * proposeDestination): pure, so every rule is checked without a database.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { proposeDestination } from "../promotion-service";

const GRADES = [
  { id: "g7", sort_order: 7 },
  { id: "g8", sort_order: 8 },
  { id: "g9", sort_order: 9 },
];

// Target-year sections: 8A, 9A, 9B. There is no 9C.
const SECTIONS = new Map([
  ["g8\u0000a", "s-8a"],
  ["g9\u0000a", "s-9a"],
  ["g9\u0000b", "s-9b"],
]);

function row(overrides: Partial<Parameters<typeof proposeDestination>[0]> = {}) {
  return {
    student_status: "enrolled",
    academic_status: "promoted" as const,
    source_section_name: "A",
    source_grade_level_id: "g8",
    source_grade_sort_order: 8,
    placed_section_id: null,
    ...overrides,
  } as Parameters<typeof proposeDestination>[0];
}

describe("proposeDestination", () => {
  test("promoted moves to the next grade's section with the same name", () => {
    expect(proposeDestination(row(), GRADES, SECTIONS)).toEqual({
      proposed_action: "place",
      proposed_section_id: "s-9a",
      reason: "promoted",
      needs_decision: false,
      done: null,
    });
  });

  test("section names match regardless of case and spaces", () => {
    const result = proposeDestination(row({ source_section_name: " b " }), GRADES, SECTIONS);
    expect(result.proposed_section_id).toBe("s-9b");
  });

  test("promoted with no matching section needs a decision", () => {
    const result = proposeDestination(row({ source_section_name: "C" }), GRADES, SECTIONS);
    expect(result).toMatchObject({
      proposed_action: "skip",
      reason: "no_matching_section",
      needs_decision: true,
    });
  });

  test("promoted from the top grade graduates", () => {
    const result = proposeDestination(
      row({ source_grade_level_id: "g9", source_grade_sort_order: 9 }),
      GRADES,
      SECTIONS,
    );
    expect(result).toMatchObject({ proposed_action: "graduate", reason: "final_grade" });
  });

  test("retained stays in the same grade and section name", () => {
    const result = proposeDestination(row({ academic_status: "retained" }), GRADES, SECTIONS);
    expect(result).toMatchObject({
      proposed_action: "place",
      proposed_section_id: "s-8a",
      reason: "retained",
    });
  });

  test("supplementary waits for the resit and is not moved", () => {
    const result = proposeDestination(row({ academic_status: "supplementary" }), GRADES, SECTIONS);
    expect(result).toMatchObject({
      proposed_action: "skip",
      reason: "awaiting_resit",
      needs_decision: false,
    });
  });

  test("incomplete or missing results need a decision, never a guess", () => {
    expect(
      proposeDestination(row({ academic_status: "incomplete" }), GRADES, SECTIONS),
    ).toMatchObject({ proposed_action: "skip", reason: "incomplete_result", needs_decision: true });
    expect(proposeDestination(row({ academic_status: null }), GRADES, SECTIONS)).toMatchObject({
      proposed_action: "skip",
      reason: "no_result",
      needs_decision: true,
    });
  });

  test("withdrawn and archived students are skipped", () => {
    for (const status of ["withdrawn", "archived"]) {
      expect(proposeDestination(row({ student_status: status }), GRADES, SECTIONS)).toMatchObject({
        proposed_action: "skip",
        reason: "inactive_student",
        needs_decision: false,
      });
    }
  });

  test("students already handled show as done", () => {
    expect(proposeDestination(row({ placed_section_id: "s-9b" }), GRADES, SECTIONS)).toMatchObject({
      proposed_action: "place",
      proposed_section_id: "s-9b",
      reason: "already_placed",
      done: "placed",
    });
    expect(
      proposeDestination(row({ student_status: "graduated" }), GRADES, SECTIONS),
    ).toMatchObject({ reason: "already_graduated", done: "graduated" });
  });
});
