// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import {
  confirmSubmissionAttachmentBodySchema,
  createSubmissionBodySchema,
  createSubmissionUploadUrlBodySchema,
  gradeSubmissionBodySchema,
  submissionListQuerySchema,
} from "../schemas";

/**
 * Request-shape validation for the submissions API (ST-104).
 *
 * Pure and database-free. These are the refusals that should never reach a service, let alone a
 * CHECK constraint -- a constraint violation surfaces as a 500 whose constraint name means nothing
 * to the caller, and every case below is decidable from the request body alone.
 */

describe("createSubmissionBodySchema", () => {
  test("accepts an attachments-only hand-in with no content", () => {
    // Not every submission is text. A student handing in only a PDF sends an empty body.
    expect(createSubmissionBodySchema.safeParse({}).success).toBe(true);
  });

  test("trims content", () => {
    const result = createSubmissionBodySchema.safeParse({ content: "  my answer  " });
    expect(result.success).toBe(true);
    expect(result.data?.content).toBe("my answer");
  });

  test("rejects content that is empty or only whitespace", () => {
    // ck_assignment_submissions_content (000049) forbids it in the database; catching it here makes
    // it a 400 naming the field. Omitting content is the way to say "no text".
    expect(createSubmissionBodySchema.safeParse({ content: "" }).success).toBe(false);
    expect(createSubmissionBodySchema.safeParse({ content: "   " }).success).toBe(false);
  });

  test("rejects content past the length ceiling", () => {
    expect(createSubmissionBodySchema.safeParse({ content: "x".repeat(100_001) }).success).toBe(
      false,
    );
    expect(createSubmissionBodySchema.safeParse({ content: "x".repeat(100_000) }).success).toBe(
      true,
    );
  });

  test("has no is_late field a client could assert", () => {
    // Lateness is derived in the database against due_at. An accepted is_late would be a second,
    // client-controlled source of truth for it.
    const result = createSubmissionBodySchema.safeParse({ content: "hi", is_late: false });
    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty("is_late");
  });
});

describe("gradeSubmissionBodySchema", () => {
  test("accepts a draft mark with only feedback", () => {
    // 000049's draft branch makes score and feedback each optional, so a marker can leave comments
    // before settling on a number.
    const result = gradeSubmissionBodySchema.safeParse({ feedback: "Nearly there." });
    expect(result.success).toBe(true);
    expect(result.data?.publish).toBe(false);
  });

  test("rejects publishing without a score", () => {
    // ck_assignment_submissions_lifecycle requires score IS NOT NULL when grade_status is
    // 'published'. This turns that constraint violation into a 400 naming the field.
    const result = gradeSubmissionBodySchema.safeParse({ publish: true, feedback: "Well done" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["score"]);
  });

  test("accepts publishing with a score", () => {
    expect(gradeSubmissionBodySchema.safeParse({ publish: true, score: 87.5 }).success).toBe(true);
  });

  test("rejects publish together with return_to_student", () => {
    // They move the row in opposite directions -- one releases a mark, the other clears it.
    const result = gradeSubmissionBodySchema.safeParse({
      publish: true,
      score: 50,
      return_to_student: true,
    });
    expect(result.success).toBe(false);
  });

  test("accepts return_to_student on its own", () => {
    expect(gradeSubmissionBodySchema.safeParse({ return_to_student: true }).success).toBe(true);
  });

  test("rejects an empty body", () => {
    expect(gradeSubmissionBodySchema.safeParse({}).success).toBe(false);
  });

  test("rejects a negative score", () => {
    expect(gradeSubmissionBodySchema.safeParse({ score: -1 }).success).toBe(false);
  });

  test("accepts a zero score", () => {
    // A zero is a real mark, not an absent one.
    expect(gradeSubmissionBodySchema.safeParse({ score: 0 }).success).toBe(true);
  });

  test("rejects more than two decimal places", () => {
    // score is numeric(10, 2); a third decimal would be silently rounded on the way in.
    expect(gradeSubmissionBodySchema.safeParse({ score: 87.555 }).success).toBe(false);
    expect(gradeSubmissionBodySchema.safeParse({ score: 87.55 }).success).toBe(true);
  });

  test("rejects an implausibly large score", () => {
    // The real ceiling is the assignment's own max_score, which only the database can check. This
    // is the cheap half: a five-figure score is a typo in every real gradebook.
    expect(gradeSubmissionBodySchema.safeParse({ score: 10_001 }).success).toBe(false);
  });

  test("accepts null feedback as an explicit clear", () => {
    const result = gradeSubmissionBodySchema.safeParse({ feedback: null });
    expect(result.success).toBe(true);
    expect(result.data?.feedback).toBeNull();
  });
});

describe("submissionListQuerySchema", () => {
  test("defaults limit and offset", () => {
    const result = submissionListQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    expect(result.data?.offset).toBe(0);
    expect(result.data?.limit).toBeGreaterThan(0);
  });

  test("coerces string query parameters", () => {
    // Query strings arrive as text; the schema is what turns them into numbers.
    const result = submissionListQuerySchema.safeParse({ limit: "25", offset: "50" });
    expect(result.success).toBe(true);
    expect(result.data?.limit).toBe(25);
    expect(result.data?.offset).toBe(50);
  });

  test("rejects a negative offset and a zero limit", () => {
    expect(submissionListQuerySchema.safeParse({ offset: -1 }).success).toBe(false);
    expect(submissionListQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
  });

  test("rejects an unknown grade_status", () => {
    expect(submissionListQuerySchema.safeParse({ grade_status: "secret" }).success).toBe(false);
  });
});

describe("attachment upload schemas", () => {
  test("rejects a file name containing a path separator", () => {
    // The name becomes the last segment of the storage key; a separator would restructure it.
    // lib/storage/keys.ts rejects it again at build time -- neither layer is relied on alone.
    for (const fileName of ["../etc/passwd", "a/b.pdf", "a\\b.pdf"]) {
      expect(
        createSubmissionUploadUrlBodySchema.safeParse({
          file_name: fileName,
          content_type: "application/pdf",
        }).success,
      ).toBe(false);
    }
  });

  test("accepts an ordinary file name", () => {
    expect(
      createSubmissionUploadUrlBodySchema.safeParse({
        file_name: "essay-final.pdf",
        content_type: "application/pdf",
      }).success,
    ).toBe(true);
  });

  test("requires content_type to look like a MIME type", () => {
    for (const contentType of ["pdf", "application", "application/", "app lication/pdf"]) {
      expect(
        createSubmissionUploadUrlBodySchema.safeParse({
          file_name: "a.pdf",
          content_type: contentType,
        }).success,
      ).toBe(false);
    }
  });

  test("requires a lowercase 64-character hex checksum when one is supplied", () => {
    const base = { storage_key: "temp/x/y/z.pdf", content_type: "application/pdf" };

    expect(confirmSubmissionAttachmentBodySchema.safeParse(base).success).toBe(true);
    expect(
      confirmSubmissionAttachmentBodySchema.safeParse({ ...base, checksum_sha256: "a".repeat(64) })
        .success,
    ).toBe(true);
    // Uppercase is rejected rather than normalised, so the value stored matches
    // ck_submission_attachments_checksum without the API having to know about that constraint.
    expect(
      confirmSubmissionAttachmentBodySchema.safeParse({ ...base, checksum_sha256: "A".repeat(64) })
        .success,
    ).toBe(false);
    expect(
      confirmSubmissionAttachmentBodySchema.safeParse({ ...base, checksum_sha256: "a".repeat(63) })
        .success,
    ).toBe(false);
  });

  test("requires a storage_key", () => {
    expect(
      confirmSubmissionAttachmentBodySchema.safeParse({
        storage_key: "",
        content_type: "application/pdf",
      }).success,
    ).toBe(false);
  });
});
