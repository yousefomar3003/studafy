// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { describe, expect, test } from "bun:test";

import {
  classifyTable,
  HARD_DELETE_TABLES,
  isPersonalDataColumn,
  LEGAL_HOLD_TABLES,
  SUBJECT_LINK_COLUMNS,
} from "./retention-registry";

describe("classifyTable", () => {
  test("financial and audit tables are legal_hold", () => {
    expect(classifyTable("subscriptions")).toBe("legal_hold");
    expect(classifyTable("audit_logs")).toBe("legal_hold");
    expect(classifyTable("invoice_cache")).toBe("legal_hold");
    expect(classifyTable("data_subject_requests")).toBe("legal_hold");
  });

  test("session/security artifacts are hard_delete", () => {
    expect(classifyTable("refresh_tokens")).toBe("hard_delete");
    expect(classifyTable("user_devices")).toBe("hard_delete");
    expect(classifyTable("oauth_identities")).toBe("hard_delete");
  });

  test("every other table defaults to redact", () => {
    expect(classifyTable("students")).toBe("redact");
    expect(classifyTable("assignment_submissions")).toBe("redact");
    expect(classifyTable("some_future_table_nobody_has_classified_yet")).toBe("redact");
  });

  test("the two sets never overlap", () => {
    for (const table of LEGAL_HOLD_TABLES) {
      expect(HARD_DELETE_TABLES.has(table)).toBe(false);
    }
  });
});

describe("isPersonalDataColumn", () => {
  test("matches verified personal columns from the real schema", () => {
    // app.users (000007), app.students/app.teachers (000008), app.materials (000011),
    // app.families (000072).
    for (const column of [
      "email",
      "normalized_email",
      "display_name",
      "first_name",
      "middle_name",
      "last_name",
      "preferred_name",
      "date_of_birth",
      "original_file_name",
    ]) {
      expect(isPersonalDataColumn(column)).toBe(true);
    }
  });

  test("does not match structural or identifier columns", () => {
    for (const column of [
      "id",
      "school_id",
      "status",
      "created_at",
      "admission_number",
      "normalized_admission_number",
      "storage_key",
      "class_id",
      "period_title",
    ]) {
      expect(isPersonalDataColumn(column)).toBe(false);
    }
  });

  test("is anchored, not substring-matched", () => {
    // A structural "*_name" column that is not one of the recognised personal-name stems must not
    // false-positive just because it ends in "_name".
    expect(isPersonalDataColumn("plan_name")).toBe(false);
    expect(isPersonalDataColumn("class_name")).toBe(false);
  });
});

describe("SUBJECT_LINK_COLUMNS", () => {
  test("is the short, verified set this module's header documents", () => {
    expect(SUBJECT_LINK_COLUMNS).toEqual(["user_id", "student_id", "teacher_id"]);
  });
});
