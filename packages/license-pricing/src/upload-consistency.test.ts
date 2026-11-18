// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { describe, expect, test } from "bun:test";

import { DEFAULT_AI_PROGRAMME_SETTINGS } from "./ai-programme";
import {
  computeUploadConsistency,
  contentBonusStanding,
  daysInRange,
  nextDay,
  schoolDaysBetween,
} from "./upload-consistency";

import type { UploadConsistencyClassInput, UploadConsistencyInput } from "./upload-consistency";

// 2026-11-01 is a Sunday. Gulf week: Sunday (7) to Thursday (4).
const GULF = [7, 1, 2, 3, 4];
const TERM = { startsOn: "2026-09-01", endsOn: "2027-01-31" };

const klass = (
  classId: string,
  uploadDates: string[],
  teacherIds: string[] = [],
  term = TERM,
): UploadConsistencyClassInput => ({ classId, term, uploadDates, teacherIds });

const input = (fields: Partial<UploadConsistencyInput>): UploadConsistencyInput => ({
  from: "2026-11-01",
  to: "2026-11-14",
  today: "2026-12-31",
  schoolWeekdays: GULF,
  holidays: [],
  classes: [],
  ...fields,
});

describe("school days", () => {
  test("only the school's teaching weekdays count", () => {
    expect(schoolDaysBetween("2026-11-01", "2026-11-07", GULF, [])).toEqual([
      "2026-11-01",
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
      "2026-11-05",
    ]);
    // A Monday-to-Friday school.
    expect(schoolDaysBetween("2026-11-01", "2026-11-07", [1, 2, 3, 4, 5], [])).toEqual([
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
      "2026-11-05",
      "2026-11-06",
    ]);
  });

  test("holidays are taken out, inclusive of both ends", () => {
    expect(
      schoolDaysBetween("2026-11-01", "2026-11-07", GULF, [
        { startsOn: "2026-11-02", endsOn: "2026-11-03" },
        { startsOn: "2026-11-05", endsOn: "2026-11-05" },
      ]),
    ).toEqual(["2026-11-01", "2026-11-04"]);
  });

  test("an empty or reversed range has none, and bad dates are refused", () => {
    expect(schoolDaysBetween("2026-11-07", "2026-11-01", GULF, [])).toEqual([]);
    expect(() => schoolDaysBetween("2026-02-30", "2026-03-01", GULF, [])).toThrow(RangeError);
    expect(daysInRange("2026-11-01", "2026-11-30")).toBe(30);
    expect(nextDay("2026-12-31")).toBe("2027-01-01");
  });
});

describe("upload consistency", () => {
  test("a class's percentage is its upload days over its school days, rounded down", () => {
    // 10 school days (Sun-Thu, two weeks); uploads on 3 of them, plus a Friday that does not count.
    const result = computeUploadConsistency(
      input({
        classes: [
          klass("a", ["2026-11-01", "2026-11-02", "2026-11-02", "2026-11-12", "2026-11-06"]),
        ],
      }),
    );
    expect(result.schoolDays).toBe(10);
    expect(result.classes).toEqual([
      { classId: "a", schoolDays: 10, uploadDays: 3, consistencyBps: 3000 },
    ]);
    expect(result.consistencyBps).toBe(3000);

    // 2 of 3 = 66.66...% -> 6666 bps, not 6667.
    const third = computeUploadConsistency(
      input({ to: "2026-11-03", classes: [klass("a", ["2026-11-01", "2026-11-02"])] }),
    );
    expect(third.classes[0]!.consistencyBps).toBe(6666);
  });

  test("an upload on a holiday counts for nothing, and the holiday is not a school day", () => {
    const result = computeUploadConsistency(
      input({
        to: "2026-11-07",
        holidays: [{ startsOn: "2026-11-03", endsOn: "2026-11-04" }],
        classes: [klass("a", ["2026-11-01", "2026-11-03"])],
      }),
    );
    expect(result.classes[0]).toMatchObject({ schoolDays: 3, uploadDays: 1, consistencyBps: 3333 });
  });

  test("days after today never count", () => {
    const result = computeUploadConsistency(
      input({ today: "2026-11-03", classes: [klass("a", ["2026-11-01", "2026-11-02"])] }),
    );
    expect(result.countedTo).toBe("2026-11-03");
    expect(result.classes[0]).toMatchObject({ schoolDays: 3, uploadDays: 2, consistencyBps: 6666 });

    const future = computeUploadConsistency(
      input({ today: "2026-10-01", classes: [klass("a", [])] }),
    );
    expect(future.schoolDays).toBe(0);
    expect(future.consistencyBps).toBeNull();
    expect(future.classes[0]!.consistencyBps).toBeNull();
  });

  test("a class counts only the days of its own term", () => {
    const result = computeUploadConsistency(
      input({
        classes: [
          // Term ends on Thursday 5 November: 5 school days in the period.
          klass("ended", ["2026-11-01"], [], { startsOn: "2026-09-01", endsOn: "2026-11-05" }),
          // Term starts after the period: no school day, left out of the average.
          klass("later", [], [], { startsOn: "2027-02-01", endsOn: "2027-06-30" }),
        ],
      }),
    );
    expect(result.classes).toEqual([
      { classId: "ended", schoolDays: 5, uploadDays: 1, consistencyBps: 2000 },
      { classId: "later", schoolDays: 0, uploadDays: 0, consistencyBps: null },
    ]);
    expect(result.classesCounted).toBe(1);
    expect(result.consistencyBps).toBe(2000);
  });

  test("the school is the mean of its classes, and a teacher the mean of theirs", () => {
    const ten = (n: number) => schoolDaysBetween("2026-11-01", "2026-11-14", GULF, []).slice(0, n);
    const result = computeUploadConsistency(
      input({
        classes: [
          klass("a", ten(10), ["t1"]), // 100%
          klass("b", ten(5), ["t1", "t2"]), // 50%
          klass("c", ten(0), ["t2", "t2"]), // 0%
        ],
      }),
    );
    expect(result.consistencyBps).toBe(5000);
    expect(result.teachers).toEqual([
      { teacherId: "t1", classIds: ["a", "b"], consistencyBps: 7500 },
      { teacherId: "t2", classIds: ["b", "c"], consistencyBps: 2500 },
    ]);
  });
});

describe("content bonus standing", () => {
  const tiers = DEFAULT_AI_PROGRAMME_SETTINGS.contentBonusTiers;

  test("the tier a consistency falls in, the next one, and where the bonus starts", () => {
    expect(contentBonusStanding(tiers, 5999)).toEqual({
      tier: { fromBps: 0, shareBps: 0 },
      nextTier: { fromBps: 6000, shareBps: 150 },
      targetBps: 6000,
    });
    expect(contentBonusStanding(tiers, 8000)).toEqual({
      tier: { fromBps: 8000, shareBps: 300 },
      nextTier: null,
      targetBps: 6000,
    });
    expect(contentBonusStanding(tiers, null).tier).toBeNull();
    expect(contentBonusStanding([], 9000)).toEqual({ tier: null, nextTier: null, targetBps: null });
  });
});
