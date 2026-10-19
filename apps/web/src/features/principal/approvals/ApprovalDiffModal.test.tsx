import { cleanup, render, screen, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, test } from "bun:test";

import { ApprovalDiffModal } from "./ApprovalDiffModal";

import type { ApprovalQueueItem } from "./queries";

afterEach(cleanup);

const REVISION: ApprovalQueueItem = {
  id: "revision-1",
  item_type: "grade_revision",
  status: "pending",
  summary: "Grade correction — Alex Kim",
  requested_by_user_id: "user-1",
  requested_by_display_name: "Jamie Chen",
  requested_at: "2026-10-01T12:00:00.000Z",
  decided_at: null,
  diff: {
    gradebook_id: "gb-1",
    gradebook_class_code: "G9-MATH",
    grade_submission_id: "submission-1",
    student_id: "student-1",
    student_name: "Alex Kim",
    reason: "Mis-keyed the midterm",
    changes: [
      { grade_id: "grade-1", label: "Midterm", max_score: 100, previous_score: 70, new_score: 78 },
    ],
  },
};

describe("ApprovalDiffModal — grade correction", () => {
  test("shows the teacher's reason and each published score next to the proposed one", () => {
    render(<ApprovalDiffModal item={REVISION} onClose={() => undefined} />);

    expect(screen.getByText("Mis-keyed the midterm")).toBeTruthy();
    const row = screen.getByText("Midterm").closest("tr");
    expect(row).toBeTruthy();
    const cells = within(row as HTMLElement).getAllByRole("cell");
    expect(cells.map((cell) => cell.textContent)).toEqual(["Midterm", "70", "78", "100"]);
  });
});
