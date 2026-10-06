// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { pickCurrentTerm, pickCurrentYear, todayIso } from "./queries";

import type { AcademicYear, Term } from "../../admin/timetable/queries";

function year(id: string, status: string, startsOn: string): AcademicYear {
  return { id, status, starts_on: startsOn, name: id } as AcademicYear;
}

function term(id: string, startsOn: string, endsOn: string): Term {
  return { id, starts_on: startsOn, ends_on: endsOn, name: id } as Term;
}

describe("pickCurrentYear", () => {
  test("prefers the year marked active", () => {
    const years = [year("old", "archived", "2024-09-01"), year("now", "active", "2025-09-01")];
    expect(pickCurrentYear(years)?.id).toBe("now");
  });

  test("falls back to the latest-starting year when none is active", () => {
    const years = [year("a", "planned", "2025-09-01"), year("b", "planned", "2026-09-01")];
    expect(pickCurrentYear(years)?.id).toBe("b");
  });

  test("is undefined when there are no years", () => {
    expect(pickCurrentYear([])).toBeUndefined();
  });
});

describe("pickCurrentTerm", () => {
  const terms = [term("t2", "2026-01-05", "2026-03-31"), term("t1", "2025-09-01", "2025-12-19")];

  test("picks the term containing today, inclusive of both ends", () => {
    expect(pickCurrentTerm(terms, "2025-12-19")?.id).toBe("t1");
    expect(pickCurrentTerm(terms, "2026-01-05")?.id).toBe("t2");
  });

  test("picks the next term to start when today falls between terms", () => {
    expect(pickCurrentTerm(terms, "2025-12-25")?.id).toBe("t2");
  });

  test("falls back to the most recent term after the last one ends", () => {
    expect(pickCurrentTerm(terms, "2026-07-01")?.id).toBe("t2");
  });
});

describe("todayIso", () => {
  test("formats the local calendar day with zero padding", () => {
    expect(todayIso(new Date(2026, 0, 5, 23, 30))).toBe("2026-01-05");
  });
});
