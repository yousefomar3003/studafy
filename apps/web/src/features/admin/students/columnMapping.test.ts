// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import {
  assignColumn,
  confirmBlocker,
  isSameMapping,
  mappingFitsHeaders,
  matchConfidence,
  missingRequiredFields,
  parentPairWarning,
  withPartialSuggestions,
} from "./columnMapping";

const COMPLETE = {
  admission_number: "Student ID",
  email: "Email",
  first_name: "First Name",
  last_name: "Surname",
};

describe("matchConfidence", () => {
  test("rates a header by how its name relates to the field", () => {
    expect(matchConfidence("first_name", "First Name")).toBe("exact");
    expect(matchConfidence("last_name", "Surname")).toBe("alias");
    expect(matchConfidence("last_name", "Student Last Name")).toBe("partial");
    expect(matchConfidence("email", "Column 4")).toBe("manual");
  });

  test("does not treat short aliases as partial matches inside longer headers", () => {
    // "last" and "dob" are aliases, but too generic to find inside another word.
    expect(matchConfidence("last_name", "Last Login")).toBe("manual");
    expect(matchConfidence("date_of_birth", "Adobe ID")).toBe("manual");
  });
});

describe("withPartialSuggestions", () => {
  test("fills unmapped fields from unclaimed headers and keeps the server's mapping", () => {
    const headers = ["Student ID", "Student First Name", "Student Last Name", "Email"];
    const suggested = withPartialSuggestions(
      { admission_number: "Student ID", email: "Email" },
      headers,
    );
    expect(suggested).toEqual({
      admission_number: "Student ID",
      email: "Email",
      first_name: "Student First Name",
      last_name: "Student Last Name",
    });
  });

  test("never suggests a header the mapping already uses", () => {
    const suggested = withPartialSuggestions({ email: "Parent Email Contact" }, [
      "Parent Email Contact",
    ]);
    expect(suggested).toEqual({ email: "Parent Email Contact" });
  });
});

describe("assignColumn", () => {
  test("moves a header that another field was using", () => {
    expect(assignColumn(COMPLETE, "middle_name", "Surname")).toEqual({
      admission_number: "Student ID",
      email: "Email",
      first_name: "First Name",
      middle_name: "Surname",
    });
  });

  test("unmaps a field", () => {
    expect(assignColumn(COMPLETE, "email", undefined).email).toBeUndefined();
  });
});

describe("missingRequiredFields / isSameMapping / mappingFitsHeaders", () => {
  test("lists required fields without a column", () => {
    expect(missingRequiredFields({ admission_number: "ID" })).toEqual([
      "email",
      "first_name",
      "last_name",
    ]);
    expect(missingRequiredFields(COMPLETE)).toEqual([]);
  });

  test("compares mappings field by field", () => {
    expect(isSameMapping(COMPLETE, { ...COMPLETE })).toBe(true);
    expect(isSameMapping(COMPLETE, { ...COMPLETE, status: "Status" })).toBe(false);
  });

  test("checks a saved mapping's headers against the file the way the server does", () => {
    const headers = ["student id", "EMAIL", "First name", "surname"];
    expect(mappingFitsHeaders(COMPLETE, headers)).toBe(true);
    expect(mappingFitsHeaders({ ...COMPLETE, status: "Status" }, headers)).toBe(false);
  });
});

describe("parentPairWarning", () => {
  test("warns only when exactly one of parent email and relationship is mapped", () => {
    expect(parentPairWarning(COMPLETE)).toBeNull();
    expect(parentPairWarning({ parent_email: "a", parent_relationship: "b" })).toBeNull();
    expect(parentPairWarning({ parent_email: "a" })).toContain("Parent relationship");
  });
});

describe("confirmBlocker", () => {
  test("blocks on missing required fields first, naming them", () => {
    expect(confirmBlocker({ admission_number: "Student ID" }, {}, 0)).toBe(
      "Map a column to every required field before confirming. Missing: Student email, First name, Last name.",
    );
  });

  test("blocks on unapplied changes, then on no valid rows", () => {
    expect(confirmBlocker(COMPLETE, {}, 5)).toContain("Apply it");
    expect(confirmBlocker(COMPLETE, COMPLETE, 0)).toContain("No rows passed validation");
    expect(confirmBlocker(COMPLETE, COMPLETE, 5)).toBeNull();
  });
});
