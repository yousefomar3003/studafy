// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { describe, expect, test } from "bun:test";

import { RECORD_DATA_TABLES } from "./records-dsr";
import {
  AUTHORED_CONTENT_TABLES,
  authoredContentAction,
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
    expect(SUBJECT_LINK_COLUMNS).toEqual(["user_id", "student_id", "teacher_id", "staff_user_id"]);
  });
});

// Custom lists (000182): a person's rows are reached by the link columns already listed, never by
// class_id; the rows and cells are handled by records-dsr.ts, and nothing about them is a legal hold.
describe("custom lists", () => {
  test("rows link to a person only through student_id and user_id", () => {
    expect(SUBJECT_LINK_COLUMNS).toContain("student_id");
    expect(SUBJECT_LINK_COLUMNS).toContain("user_id");
    expect(SUBJECT_LINK_COLUMNS).not.toContain("class_id");
  });

  test("no custom list table is a legal hold or a bare hard delete", () => {
    for (const table of [
      "custom_lists",
      "custom_list_columns",
      "custom_list_column_options",
      "custom_list_rows",
      "custom_list_values",
    ]) {
      expect(classifyTable(table)).toBe("redact");
    }
  });

  test("rows and cells are exported opened and erased by records-dsr.ts, not the generic walk", () => {
    expect(RECORD_DATA_TABLES.has("custom_list_rows")).toBe(true);
    expect(RECORD_DATA_TABLES.has("custom_list_values")).toBe(true);
  });
});

// What a person wrote themselves (authored-content-dsr.ts). The boundary is as much what is NOT here
// as what is: the school's own records stay.
describe("AUTHORED_CONTENT_TABLES", () => {
  test("messages keep their row and lose their text; their images and AI content are deleted", () => {
    expect(authoredContentAction("messages")).toBe("replace_text");
    expect(authoredContentAction("notifications")).toBe("replace_text");
    expect(authoredContentAction("message_attachments")).toBe("delete");
    for (const table of [
      "ai_conversations",
      "ai_messages",
      "quizzes",
      "flashcard_decks",
      "exam_sessions",
    ]) {
      expect(authoredContentAction(table)).toBe("delete");
    }
  });

  test("never reaches school records, safeguarding reports or a legal hold", () => {
    for (const table of [
      "assignment_submissions",
      "submission_attachments",
      "grades",
      "grade_submissions",
      "attendance_records",
      "audit_logs",
      "message_reports",
      "message_report_messages",
      "message_report_attachments",
      "ai_content_reports",
      "ai_moderation_decisions",
      "ai_usage_meters",
      "ai_data_sharing_consents",
      "message_conversations",
    ]) {
      expect(authoredContentAction(table)).toBeNull();
    }
    for (const table of AUTHORED_CONTENT_TABLES.keys()) {
      expect(LEGAL_HOLD_TABLES.has(table)).toBe(false);
      expect(HARD_DELETE_TABLES.has(table)).toBe(false);
      expect(RECORD_DATA_TABLES.has(table)).toBe(false);
    }
  });
});
