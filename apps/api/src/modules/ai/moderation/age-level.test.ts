/**
 * QA-029: the moderation level is the server's decision, from the student's age.
 *
 * Ask AI took `level` from the request body and defaulted to "high", the most permissive filter,
 * so a primary-school student -- or any client that left the field out -- got the weakest content
 * moderation. The level now comes from the student's date of birth; a client may ask only for a
 * stricter one.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { describe, expect, test } from "bun:test";

import { effectiveAgeLevel } from "./age-level";

const NOW = new Date("2026-11-17T12:00:00Z");

describe("effectiveAgeLevel (QA-029)", () => {
  test("an eight-year-old is moderated as elementary, whatever the client asks", () => {
    expect(effectiveAgeLevel("2018-05-01", undefined, NOW)).toBe("elementary");
    expect(effectiveAgeLevel("2018-05-01", "high", NOW)).toBe("elementary");
    expect(effectiveAgeLevel("2018-05-01", "middle", NOW)).toBe("elementary");
  });

  test("bands by age: under 11 elementary, 11-13 middle, 14+ high", () => {
    expect(effectiveAgeLevel("2015-11-18", undefined, NOW)).toBe("elementary"); // 10
    expect(effectiveAgeLevel("2015-11-17", undefined, NOW)).toBe("middle"); // 11 today
    expect(effectiveAgeLevel("2012-11-18", undefined, NOW)).toBe("middle"); // 13
    expect(effectiveAgeLevel("2012-11-17", undefined, NOW)).toBe("high"); // 14 today
  });

  test("a client may make it stricter, never looser", () => {
    expect(effectiveAgeLevel("2008-01-01", "elementary", NOW)).toBe("elementary");
    expect(effectiveAgeLevel("2008-01-01", "middle", NOW)).toBe("middle");
    expect(effectiveAgeLevel("2014-01-01", "high", NOW)).toBe("middle");
  });

  test("with no date of birth on record, the default is not the most permissive", () => {
    expect(effectiveAgeLevel(null, undefined, NOW)).toBe("middle");
    expect(effectiveAgeLevel(null, "high", NOW)).toBe("middle");
    expect(effectiveAgeLevel(null, "elementary", NOW)).toBe("elementary");
  });

  test("Ask AI moderates with the derived level, not the request body's", () => {
    const route = readFileSync(join(import.meta.dir, "../routes/ask-routes.ts"), "utf8");
    expect(route).not.toMatch(/moderate(Input|Output)\([^)]*body\.level/);
    expect(route).toContain("effectiveAgeLevel(");
  });
});
