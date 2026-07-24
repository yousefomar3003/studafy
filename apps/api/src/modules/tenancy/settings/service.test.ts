/* eslint-disable import-x/no-unresolved -- "bun:test" is a virtual Bun built-in */
import { describe, expect, test } from "bun:test";
/* eslint-enable import-x/no-unresolved */

import { getSchoolSettings, updateSchoolSettings } from "./service";

describe("School settings service", () => {
  test("getSchoolSettings is a function", () => {
    expect(typeof getSchoolSettings).toBe("function");
  });

  test("updateSchoolSettings is a function", () => {
    expect(typeof updateSchoolSettings).toBe("function");
  });
});
