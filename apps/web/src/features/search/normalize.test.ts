// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { normalizeSearchText, searchTokens } from "./normalize";

describe("normalizeSearchText", () => {
  test("unifies alef forms, so أحمد and احمد are the same word", () => {
    expect(normalizeSearchText("أحمد")).toBe(normalizeSearchText("احمد"));
    expect(normalizeSearchText("إيمان")).toBe("ايمان");
    expect(normalizeSearchText("آمنة")).toBe("امنه");
  });

  test("strips diacritics and tatweel", () => {
    expect(normalizeSearchText("مُحَمَّد")).toBe("محمد");
    expect(normalizeSearchText("مـــدرسة")).toBe("مدرسه");
  });

  test("folds ى to ي and ة to ه", () => {
    expect(normalizeSearchText("مصطفى")).toBe("مصطفي");
    expect(normalizeSearchText("فاطمة")).toBe("فاطمه");
  });

  test("lowercases Latin and collapses whitespace", () => {
    expect(normalizeSearchText("  Academic   SETUP ")).toBe("academic setup");
  });
});

describe("searchTokens", () => {
  test("splits on punctuation, keeping letters and digits", () => {
    expect(searchTokens("INV-0012, grade-scales")).toEqual(["inv", "0012", "grade", "scales"]);
    expect(searchTokens("ربط ولي الأمر")).toEqual(["ربط", "ولي", "الامر"]);
  });
});
