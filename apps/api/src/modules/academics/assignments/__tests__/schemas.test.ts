/**
 * Assignment request-schema tests (ST-103).
 *
 * These cover the 400 contract: which malformed requests are rejected at the edge rather than
 * reaching PostgreSQL and surfacing as a CHECK-constraint 500 whose constraint name means nothing
 * to a client.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import {
  assignmentListQuerySchema,
  confirmAttachmentBodySchema,
  createAssignmentBodySchema,
  createUploadUrlBodySchema,
  updateAssignmentBodySchema,
} from "../schemas";

const CLASS_ID = "44444444-4444-4444-8444-444444444444";

function validCreateBody(overrides: Record<string, unknown> = {}) {
  return {
    class_id: CLASS_ID,
    title: "Problem Set 3",
    due_at: "2026-09-01T23:59:00.000Z",
    max_score: 100,
    ...overrides,
  };
}

describe("createAssignmentBodySchema", () => {
  test("accepts a minimal valid body and defaults to draft", () => {
    const parsed = createAssignmentBodySchema.parse(validCreateBody());
    expect(parsed.status).toBe("draft");
    expect(parsed.allow_late_submission).toBe(false);
  });

  test("rejects available_from after due_at", () => {
    // Mirrors ck_assignments_availability. Caught here so the caller gets a field-level 400.
    const result = createAssignmentBodySchema.safeParse(
      validCreateBody({
        available_from: "2026-09-02T00:00:00.000Z",
        due_at: "2026-09-01T23:59:00.000Z",
      }),
    );

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["available_from"]);
  });

  test("accepts available_from equal to due_at", () => {
    // The database constraint is `due_at >= available_from`, so equality is legal and the schema
    // must not be stricter than the table it writes to.
    const at = "2026-09-01T23:59:00.000Z";
    expect(
      createAssignmentBodySchema.safeParse(validCreateBody({ available_from: at, due_at: at }))
        .success,
    ).toBe(true);
  });

  test("rejects a non-positive max_score", () => {
    expect(createAssignmentBodySchema.safeParse(validCreateBody({ max_score: 0 })).success).toBe(
      false,
    );
    expect(createAssignmentBodySchema.safeParse(validCreateBody({ max_score: -5 })).success).toBe(
      false,
    );
  });

  test("rejects more than two decimal places on max_score", () => {
    // max_score is numeric(10, 2); a third decimal would be silently rounded on insert.
    expect(
      createAssignmentBodySchema.safeParse(validCreateBody({ max_score: 10.005 })).success,
    ).toBe(false);
  });

  test("rejects an implausibly large max_score", () => {
    expect(
      createAssignmentBodySchema.safeParse(validCreateBody({ max_score: 1_000_000 })).success,
    ).toBe(false);
  });

  test("rejects a malformed due_at", () => {
    expect(
      createAssignmentBodySchema.safeParse(validCreateBody({ due_at: "2026-09-01" })).success,
    ).toBe(false);
    expect(
      createAssignmentBodySchema.safeParse(validCreateBody({ due_at: "not a date" })).success,
    ).toBe(false);
  });

  test("rejects a blank or whitespace-only title", () => {
    expect(createAssignmentBodySchema.safeParse(validCreateBody({ title: "" })).success).toBe(
      false,
    );
    expect(createAssignmentBodySchema.safeParse(validCreateBody({ title: "   " })).success).toBe(
      false,
    );
  });

  test("cannot be created directly as archived", () => {
    expect(
      createAssignmentBodySchema.safeParse(validCreateBody({ status: "archived" })).success,
    ).toBe(false);
  });
});

describe("updateAssignmentBodySchema", () => {
  test("rejects an empty patch", () => {
    // An empty body would otherwise produce an UPDATE that changes only updated_at, plus an audit
    // row recording a change that did not happen.
    expect(updateAssignmentBodySchema.safeParse({}).success).toBe(false);
  });

  test("accepts a single field", () => {
    expect(updateAssignmentBodySchema.safeParse({ title: "Renamed" }).success).toBe(true);
  });

  test("rejects an inverted date pair when both are supplied", () => {
    expect(
      updateAssignmentBodySchema.safeParse({
        available_from: "2026-09-02T00:00:00.000Z",
        due_at: "2026-09-01T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  test("allows clearing a nullable field", () => {
    expect(updateAssignmentBodySchema.safeParse({ description: null }).success).toBe(true);
  });
});

describe("assignmentListQuerySchema", () => {
  test("defaults limit and leaves cursor absent", () => {
    const parsed = assignmentListQuerySchema.parse({});
    expect(parsed.limit).toBe(20);
    expect(parsed.cursor).toBeUndefined();
  });

  test("coerces a string limit from the query string", () => {
    expect(assignmentListQuerySchema.parse({ limit: "50" }).limit).toBe(50);
  });

  test("rejects a limit above the shared pagination cap", () => {
    expect(assignmentListQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
  });

  test("rejects an unknown status filter", () => {
    // `draft` is a column value, not one of the three derived filters this endpoint accepts.
    expect(assignmentListQuerySchema.safeParse({ status: "draft" }).success).toBe(false);
  });

  test("accepts each derived status filter", () => {
    for (const status of ["upcoming", "past_due", "submitted"]) {
      expect(assignmentListQuerySchema.safeParse({ status }).success).toBe(true);
    }
  });
});

describe("attachment bodies", () => {
  test("rejects a file name containing a path separator", () => {
    expect(
      createUploadUrlBodySchema.safeParse({
        file_name: "../escape.pdf",
        content_type: "application/pdf",
      }).success,
    ).toBe(false);
  });

  test("rejects a content type that is not a MIME type", () => {
    expect(
      createUploadUrlBodySchema.safeParse({ file_name: "a.pdf", content_type: "pdf" }).success,
    ).toBe(false);
  });

  test("rejects a checksum that is not lowercase hex sha-256", () => {
    const base = { storage_key: "temp/a/b/c.pdf", content_type: "application/pdf" };

    expect(confirmAttachmentBodySchema.safeParse({ ...base, checksum_sha256: "abc" }).success).toBe(
      false,
    );
    expect(
      confirmAttachmentBodySchema.safeParse({ ...base, checksum_sha256: "A".repeat(64) }).success,
    ).toBe(false);
    expect(
      confirmAttachmentBodySchema.safeParse({ ...base, checksum_sha256: "a".repeat(64) }).success,
    ).toBe(true);
  });
});
