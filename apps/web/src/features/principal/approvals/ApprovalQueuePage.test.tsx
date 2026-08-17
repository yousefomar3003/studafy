import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";

import type { ComponentType } from "react";

const ITEM_A = {
  id: "item-a",
  item_type: "grade_submission",
  status: "submitted",
  summary: "Grade 9 Math — Q3 midterm",
  requested_by_user_id: "user-1",
  requested_by_display_name: "Jamie Chen",
  requested_at: "2026-08-01T12:00:00.000Z",
  decided_at: null,
  diff: {
    gradebook_id: "gb-1",
    gradebook_class_code: "G9-MATH",
    student_id: "student-1",
    student_name: "Alex Kim",
    grade_count: 1,
    grades: [{ label: "Midterm", score: 85, max_score: 100, weight: 1 }],
  },
};

const ITEM_B = {
  id: "item-b",
  item_type: "timetable_version",
  status: "pending",
  summary: "Timetable — Fall v2",
  requested_by_user_id: "user-2",
  requested_by_display_name: "Morgan Lee",
  requested_at: "2026-08-02T09:00:00.000Z",
  decided_at: null,
  diff: { version_name: "Fall v2", term_name: "Fall 2026", slot_count: 32 },
};

const getMock = mock((_path: string) =>
  Promise.resolve<unknown>({ data: { items: [ITEM_A, ITEM_B], total: 2 } }),
);
const postMock = mock((_path: string, _init?: unknown) =>
  Promise.resolve<unknown>({ data: undefined }),
);

mock.module("../../../lib/api", () => ({ api: { GET: getMock, POST: postMock } }));

const loadApprovalQueuePage = async (): Promise<ComponentType> =>
  (await import("./ApprovalQueuePage")).default;

function renderPage(Page: ComponentType) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <Page />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
  postMock.mockReset();
});

describe("ApprovalQueuePage", () => {
  test("renders the pending items returned by the approval queue", async () => {
    getMock.mockImplementation(() =>
      Promise.resolve({ data: { items: [ITEM_A, ITEM_B], total: 2 } }),
    );

    renderPage(await loadApprovalQueuePage());

    expect(await screen.findByText("Grade 9 Math — Q3 midterm")).toBeTruthy();
    expect(screen.getByText("Jamie Chen")).toBeTruthy();
    expect(screen.getByText("Timetable — Fall v2")).toBeTruthy();
  });

  test("renders an empty-state message when nothing is pending", async () => {
    getMock.mockImplementation(() => Promise.resolve({ data: { items: [], total: 0 } }));

    renderPage(await loadApprovalQueuePage());

    expect(await screen.findByText("Nothing is pending review.")).toBeTruthy();
  });

  test("the diff modal shows the submission's grades", async () => {
    getMock.mockImplementation(() => Promise.resolve({ data: { items: [ITEM_A], total: 1 } }));

    renderPage(await loadApprovalQueuePage());
    await screen.findByText("Grade 9 Math — Q3 midterm");

    fireEvent.click(screen.getByRole("button", { name: "View diff" }));

    const dialog = await screen.findByRole("dialog", { name: "What changed" });
    expect(within(dialog).getByText("Alex Kim")).toBeTruthy();
    expect(within(dialog).getByText("Midterm")).toBeTruthy();
    expect(within(dialog).getByText("85")).toBeTruthy();
  });

  test("approving a row calls the decision endpoint and the item leaves the queue live", async () => {
    getMock
      .mockImplementationOnce(() =>
        Promise.resolve({ data: { items: [ITEM_A, ITEM_B], total: 2 } }),
      )
      .mockImplementationOnce(() => Promise.resolve({ data: { items: [ITEM_B], total: 1 } }));
    postMock.mockImplementation(() =>
      Promise.resolve({
        data: {
          results: [
            { item_type: "grade_submission", id: "item-a", status: "approved", error: null },
          ],
          summary: { total: 1, succeeded: 1, failed: 0 },
        },
      }),
    );

    renderPage(await loadApprovalQueuePage());
    await screen.findByText("Grade 9 Math — Q3 midterm");

    const row = screen.getByText("Grade 9 Math — Q3 midterm").closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    const [path, init] = postMock.mock.calls[0] as [string, { body: { items: unknown[] } }];
    expect(path).toBe("/api/approvals/bulk-decision");
    expect(init.body).toEqual({
      items: [{ item_type: "grade_submission", id: "item-a", action: "approve" }],
    });

    expect(await screen.findByText("Item approved")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("Grade 9 Math — Q3 midterm")).toBeNull());
    expect(screen.getByText("Timetable — Fall v2")).toBeTruthy();
  });

  test("rejecting a row requires a non-empty reason before it submits", async () => {
    getMock.mockImplementation(() => Promise.resolve({ data: { items: [ITEM_A], total: 1 } }));
    postMock.mockImplementation(() =>
      Promise.resolve({
        data: {
          results: [
            { item_type: "grade_submission", id: "item-a", status: "rejected", error: null },
          ],
          summary: { total: 1, succeeded: 1, failed: 0 },
        },
      }),
    );

    renderPage(await loadApprovalQueuePage());
    await screen.findByText("Grade 9 Math — Q3 midterm");

    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    const dialog = await screen.findByRole("dialog", { name: "Reject item" });

    fireEvent.click(within(dialog).getByRole("button", { name: "Reject" }));
    expect(await within(dialog).findByText("A reason is required to reject.")).toBeTruthy();
    expect(postMock).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByLabelText("Reason", { exact: false }), {
      target: { value: "Missing rubric scores" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Reject" }));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    const [, init] = postMock.mock.calls[0] as [string, { body: { items: unknown[] } }];
    expect(init.body).toEqual({
      items: [
        {
          item_type: "grade_submission",
          id: "item-a",
          action: "reject",
          rejection_reason: "Missing rubric scores",
        },
      ],
    });
    expect(await screen.findByText("Item rejected")).toBeTruthy();
  });

  test("bulk approve surfaces per-row failures and empties the queue for the rest", async () => {
    getMock
      .mockImplementationOnce(() =>
        Promise.resolve({ data: { items: [ITEM_A, ITEM_B], total: 2 } }),
      )
      .mockImplementationOnce(() => Promise.resolve({ data: { items: [ITEM_B], total: 1 } }));
    postMock.mockImplementation(() =>
      Promise.resolve({
        data: {
          results: [
            { item_type: "grade_submission", id: "item-a", status: "approved", error: null },
            {
              item_type: "timetable_version",
              id: "item-b",
              status: null,
              error: "Version already approved",
            },
          ],
          summary: { total: 2, succeeded: 1, failed: 1 },
        },
      }),
    );

    renderPage(await loadApprovalQueuePage());
    await screen.findByText("Grade 9 Math — Q3 midterm");

    fireEvent.click(screen.getByRole("checkbox", { name: "Select all pending items" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve 2 selected" }));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));

    expect(await screen.findByText("1 of 2 approved")).toBeTruthy();
    expect(await screen.findByText("Version already approved")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("Grade 9 Math — Q3 midterm")).toBeNull());
    expect(screen.getByText("Timetable — Fall v2")).toBeTruthy();
  });

  test("bulk reject applies one shared reason to every selected item", async () => {
    getMock
      .mockImplementationOnce(() =>
        Promise.resolve({ data: { items: [ITEM_A, ITEM_B], total: 2 } }),
      )
      .mockImplementationOnce(() => Promise.resolve({ data: { items: [], total: 0 } }));
    postMock.mockImplementation(() =>
      Promise.resolve({
        data: {
          results: [
            { item_type: "grade_submission", id: "item-a", status: "rejected", error: null },
            { item_type: "timetable_version", id: "item-b", status: "rejected", error: null },
          ],
          summary: { total: 2, succeeded: 2, failed: 0 },
        },
      }),
    );

    renderPage(await loadApprovalQueuePage());
    await screen.findByText("Grade 9 Math — Q3 midterm");

    fireEvent.click(screen.getByRole("checkbox", { name: "Select all pending items" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject 2 selected" }));

    const dialog = await screen.findByRole("dialog", { name: "Reject selected items" });
    expect(within(dialog).getByText("2 items selected")).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText("Reason", { exact: false }), {
      target: { value: "Submitted before the grading window opened" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Reject" }));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    const [path, init] = postMock.mock.calls[0] as [string, { body: { items: unknown[] } }];
    expect(path).toBe("/api/approvals/bulk-decision");
    expect(init.body).toEqual({
      items: [
        {
          item_type: "grade_submission",
          id: "item-a",
          action: "reject",
          rejection_reason: "Submitted before the grading window opened",
        },
        {
          item_type: "timetable_version",
          id: "item-b",
          action: "reject",
          rejection_reason: "Submitted before the grading window opened",
        },
      ],
    });

    expect(await screen.findByText("2 of 2 items rejected")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(screen.queryByText("Grade 9 Math — Q3 midterm")).toBeNull());
    expect(await screen.findByText("Nothing is pending review.")).toBeTruthy();
  });

  test("bulk reject requires a reason before it submits", async () => {
    getMock.mockImplementation(() =>
      Promise.resolve({ data: { items: [ITEM_A, ITEM_B], total: 2 } }),
    );

    renderPage(await loadApprovalQueuePage());
    await screen.findByText("Grade 9 Math — Q3 midterm");

    fireEvent.click(screen.getByRole("checkbox", { name: "Select all pending items" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject 2 selected" }));

    const dialog = await screen.findByRole("dialog", { name: "Reject selected items" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Reject" }));

    expect(await within(dialog).findByText("A reason is required to reject.")).toBeTruthy();
    expect(postMock).not.toHaveBeenCalled();
  });
});
