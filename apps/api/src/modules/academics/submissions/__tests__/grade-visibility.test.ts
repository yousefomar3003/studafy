// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { toSubmissionResponse } from "../routes/submission-routes";
import { gradeIsVisible } from "../submission-service";

import type { SubmissionRow } from "../submission-service";

/**
 * The privacy rule, proved without a database (ST-104).
 *
 * This is the whole of "teacher feedback and grades are visible only to the submitting student and
 * their linked parent, and only once released". Row visibility -- which student's work a caller can
 * see at all -- is the RLS layer's job and is covered by the integration suite. What is tested here
 * is the COLUMN rule that RLS structurally cannot express: a submission that is visible, carrying
 * marks that are not.
 *
 * It is a separate file, and pure, on purpose. This is the most security-relevant decision in the
 * module, and a test for it that only runs when TEST_DATABASE_URL happens to be set is a test that
 * silently does not run.
 */

const BASE_ROW: SubmissionRow = {
  id: "11111111-1111-4111-8111-111111111111",
  school_id: "22222222-2222-4222-8222-222222222222",
  assignment_id: "33333333-3333-4333-8333-333333333333",
  student_id: "44444444-4444-4444-8444-444444444444",
  content: "My answer to question 1.",
  status: "submitted",
  grade_status: "none",
  is_late: false,
  attempt_number: 1,
  submitted_at: new Date("2026-03-01T09:00:00.000Z"),
  graded_at: null,
  graded_by_user_id: null,
  score: null,
  feedback: null,
  last_edited_by_user_id: "55555555-5555-4555-8555-555555555555",
  created_at: new Date("2026-03-01T09:00:00.000Z"),
  updated_at: new Date("2026-03-01T09:00:00.000Z"),
};

/** A row a teacher has marked but not released. Every grading field is populated. */
const DRAFT_GRADED: SubmissionRow = {
  ...BASE_ROW,
  grade_status: "draft",
  graded_at: new Date("2026-03-02T14:30:00.000Z"),
  graded_by_user_id: "66666666-6666-4666-8666-666666666666",
  score: "87.50",
  feedback: "Good work, but check your units in Q3.",
};

/** The same marks, released. status has moved too -- 000049's constraint requires it. */
const PUBLISHED: SubmissionRow = {
  ...DRAFT_GRADED,
  status: "graded",
  grade_status: "published",
};

describe("gradeIsVisible", () => {
  // The full truth table. Staff always see marks; everyone else only after publication.
  const cases: readonly (readonly [SubmissionRow["grade_status"], boolean, boolean])[] = [
    ["none", false, false],
    ["none", true, true],
    ["draft", false, false],
    ["draft", true, true],
    ["published", false, true],
    ["published", true, true],
  ];

  for (const [gradeStatus, viewerIsStaff, expected] of cases) {
    test(`grade_status=${gradeStatus}, staff=${viewerIsStaff} -> ${expected}`, () => {
      expect(gradeIsVisible({ grade_status: gradeStatus }, viewerIsStaff)).toBe(expected);
    });
  }
});

describe("toSubmissionResponse withholding", () => {
  test("withholds every grading field from a non-staff viewer while the grade is a draft", () => {
    const response = toSubmissionResponse(DRAFT_GRADED, [], false);

    // The four fields the ticket names. All four, not most of them.
    expect(response.score).toBeNull();
    expect(response.feedback).toBeNull();
    expect(response.graded_at).toBeNull();
    expect(response.graded_by_user_id).toBeNull();
  });

  test("reports grade_status as 'none', never 'draft', to a non-staff viewer", () => {
    // Passing 'draft' through would leak precisely the fact the nulls above exist to hide: that a
    // teacher has begun marking. A student must not be able to distinguish "unmarked" from
    // "marked, awaiting release".
    expect(toSubmissionResponse(DRAFT_GRADED, [], false).grade_status).toBe("none");
    expect(toSubmissionResponse(BASE_ROW, [], false).grade_status).toBe("none");
  });

  test("an unmarked row and a draft-marked row are indistinguishable to a student", () => {
    const unmarked = toSubmissionResponse(BASE_ROW, [], false);
    const marked = toSubmissionResponse(DRAFT_GRADED, [], false);

    // Field-by-field equality across everything a draft grade touches. If a future change adds a
    // grading field and forgets to withhold it, this fails even when the four assertions above
    // still pass.
    expect({
      status: marked.status,
      grade_status: marked.grade_status,
      score: marked.score,
      feedback: marked.feedback,
      graded_at: marked.graded_at,
      graded_by_user_id: marked.graded_by_user_id,
    }).toEqual({
      status: unmarked.status,
      grade_status: unmarked.grade_status,
      score: unmarked.score,
      feedback: unmarked.feedback,
      graded_at: unmarked.graded_at,
      graded_by_user_id: unmarked.graded_by_user_id,
    });
  });

  test("shows a staff viewer the true draft values", () => {
    const response = toSubmissionResponse(DRAFT_GRADED, [], true);

    expect(response.grade_status).toBe("draft");
    expect(response.score).toBe(87.5);
    expect(response.feedback).toBe("Good work, but check your units in Q3.");
    expect(response.graded_at).toBe("2026-03-02T14:30:00.000Z");
    expect(response.graded_by_user_id).toBe("66666666-6666-4666-8666-666666666666");
  });

  test("shows a non-staff viewer everything once the grade is published", () => {
    const response = toSubmissionResponse(PUBLISHED, [], false);

    expect(response.grade_status).toBe("published");
    expect(response.status).toBe("graded");
    expect(response.score).toBe(87.5);
    expect(response.feedback).toBe("Good work, but check your units in Q3.");
    expect(response.graded_at).toBe("2026-03-02T14:30:00.000Z");
    expect(response.graded_by_user_id).toBe("66666666-6666-4666-8666-666666666666");
  });
});

describe("toSubmissionResponse projection", () => {
  test("never withholds the student's own work, only the marks on it", () => {
    // The reason this is a column rule and not an RLS gate: hiding the row while it is being
    // marked would make a student's own hand-in vanish from their view.
    const response = toSubmissionResponse(DRAFT_GRADED, [], false);

    expect(response.content).toBe("My answer to question 1.");
    expect(response.submitted_at).toBe("2026-03-01T09:00:00.000Z");
    expect(response.attempt_number).toBe(1);
  });

  test("is_late survives grading and is never withheld", () => {
    // 000011 modelled lateness as status='late', mutually exclusive with 'graded', so marking a
    // late hand-in erased the fact. is_late is orthogonal precisely so this holds.
    const lateAndPublished: SubmissionRow = { ...PUBLISHED, is_late: true };

    expect(toSubmissionResponse(lateAndPublished, [], false).is_late).toBe(true);
    expect(toSubmissionResponse({ ...DRAFT_GRADED, is_late: true }, [], false).is_late).toBe(true);
  });

  test("converts the numeric score from its string representation exactly once", () => {
    // postgres.js hands numeric back as a string rather than narrowing an arbitrary-precision type
    // to an IEEE double. This is the single place that conversion happens.
    expect(toSubmissionResponse({ ...PUBLISHED, score: "87.50" }, [], true).score).toBe(87.5);
    expect(toSubmissionResponse({ ...PUBLISHED, score: "0.00" }, [], true).score).toBe(0);
    expect(toSubmissionResponse({ ...PUBLISHED, score: "100" }, [], true).score).toBe(100);
  });

  test("distinguishes a withheld score from a genuine zero", () => {
    // A zero score is a real mark and must not be flattened to null, which is what a truthiness
    // check would do.
    expect(toSubmissionResponse({ ...PUBLISHED, score: "0" }, [], false).score).toBe(0);
    expect(toSubmissionResponse({ ...DRAFT_GRADED, score: "0" }, [], false).score).toBeNull();
  });

  test("never emits a storage key for an attachment", () => {
    const response = toSubmissionResponse(PUBLISHED, [], true);
    expect(JSON.stringify(response)).not.toContain("permanent/");
    expect(Object.keys(response)).not.toContain("storage_key");
  });
});
