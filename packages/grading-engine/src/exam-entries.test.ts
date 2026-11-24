// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { EXAM_ENTRY_STATUSES, canChangeExamEntryStatus, nextCandidateNumbers } from "./index";

describe("canChangeExamEntryStatus", () => {
  test("draft -> entered -> withdrawn, and a withdrawn entry can be reinstated", () => {
    expect(canChangeExamEntryStatus("draft", "entered")).toBe(true);
    expect(canChangeExamEntryStatus("entered", "withdrawn")).toBe(true);
    expect(canChangeExamEntryStatus("withdrawn", "entered")).toBe(true);
  });

  test("a draft is not withdrawn and nothing goes back to draft", () => {
    expect(canChangeExamEntryStatus("draft", "withdrawn")).toBe(false);
    expect(canChangeExamEntryStatus("entered", "draft")).toBe(false);
    expect(canChangeExamEntryStatus("withdrawn", "draft")).toBe(false);
  });

  test("staying in the same status is not a change", () => {
    for (const status of EXAM_ENTRY_STATUSES) {
      expect(canChangeExamEntryStatus(status, status)).toBe(false);
    }
  });
});

describe("nextCandidateNumbers", () => {
  test("pads to the width and counts up from the start", () => {
    expect(nextCandidateNumbers(3, { start: 1, width: 4, prefix: "" }, [])).toEqual([
      "0001",
      "0002",
      "0003",
    ]);
  });

  test("skips numbers already in use, whatever their case", () => {
    expect(
      nextCandidateNumbers(3, { start: 10, width: 0, prefix: "jo-" }, ["JO-11", "jo-13"]),
    ).toEqual(["jo-10", "jo-12", "jo-14"]);
  });

  test("never pads below one digit or starts below zero", () => {
    expect(nextCandidateNumbers(2, { start: -5, width: 0, prefix: "" }, [])).toEqual(["0", "1"]);
  });

  test("a number wider than the width is written in full", () => {
    expect(nextCandidateNumbers(2, { start: 99, width: 2, prefix: "" }, [])).toEqual(["99", "100"]);
  });

  test("nothing to number", () => {
    expect(nextCandidateNumbers(0, { start: 1, width: 4, prefix: "" }, ["0001"])).toEqual([]);
  });
});
