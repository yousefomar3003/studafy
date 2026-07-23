/* eslint-disable import-x/no-unresolved -- "bun:test" is a virtual Bun built-in */
import { describe, expect, test } from "bun:test";
/* eslint-enable import-x/no-unresolved */

import { registerSchool } from "./service";

describe("Registration service", () => {
  test("registerSchool is a function", () => {
    expect(typeof registerSchool).toBe("function");
  });
});
