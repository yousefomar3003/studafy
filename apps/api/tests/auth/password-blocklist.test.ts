import { describe, expect, test } from "bun:test"; // eslint-disable-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in

import { checkNewPassword } from "../../src/modules/auth/services/member-password-service";
import { isCommonPassword } from "../../src/modules/auth/services/password-blocklist";

describe("common member passwords", () => {
  test.each([
    "password",
    "Password123",
    "PASSWORD!",
    "12345678",
    "123456789",
    "87654321",
    "qwertyuiop",
    "Qwerty123",
    "asdfghjkl",
    "abcdefgh",
    "aaaaaaaa",
    "abababab",
    "abc1abc1",
    "iloveyou",
    "Studafy2026",
    "studafy@1",
    "school!!!",
    "Student123",
    "P@ssw0rd2024",
    "123password",
    "bismillah",
  ])("refuses %p", (password) => {
    expect(isCommonPassword(password)).toBe(true);
    expect(checkNewPassword(password, "STU-100001")).toBe("TOO_COMMON");
  });

  test.each([
    "Blue-Kite-42",
    "Teach-Pass-9",
    "olive tram nine",
    "Saturn&Pickle7",
    "mY dog Rex 2015",
  ])("accepts %p", (password) => {
    expect(isCommonPassword(password)).toBe(false);
    expect(checkNewPassword(password, "STU-100001")).toBeNull();
  });

  test("a password built on the member's own ID is refused", () => {
    expect(checkNewPassword("stu-100001", "STU-100001")).toBe("SAME_AS_USERNAME");
    expect(checkNewPassword("Kite100001!", "STU-100001")).toBe("SAME_AS_USERNAME");
    expect(checkNewPassword("Kite100001!", "PAR-200002")).toBeNull();
  });

  test("length is still checked first", () => {
    expect(checkNewPassword("pass", "STU-100001")).toBe("TOO_SHORT");
  });
});
