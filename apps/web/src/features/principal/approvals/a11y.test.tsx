import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, mock, test } from "bun:test";

import { expectNoA11yViolations } from "../../../lib/test/axe";

import type { ComponentType } from "react";

/**
 * Automated accessibility audit for the approval queue, mirroring `admin/invitations/a11y.test.tsx`
 * — one render per representative state (the list, the diff modal, and the reject-reason modal)
 * inside a `<main>`, matching how `RootLayout` wraps every route.
 */

const ITEM = {
  id: "item-a",
  item_type: "grade_submission" as const,
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

const getMock = mock((_path: string) =>
  Promise.resolve<unknown>({ data: { items: [ITEM], total: 1 } }),
);
const postMock = mock((_path: string, _init?: unknown) =>
  Promise.resolve<unknown>({ data: undefined }),
);

mock.module("../../../lib/api", () => ({ api: { GET: getMock, POST: postMock } }));

const loadApprovalQueuePage = async (): Promise<ComponentType> =>
  (await import("./ApprovalQueuePage")).default;

function renderInMain(Page: ComponentType) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <main>
          <Page />
        </main>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
  postMock.mockReset();
});

describe("approval queue accessibility", () => {
  test("queue list", async () => {
    getMock.mockImplementation(() => Promise.resolve({ data: { items: [ITEM], total: 1 } }));

    const { container } = renderInMain(await loadApprovalQueuePage());
    await screen.findByText("Grade 9 Math — Q3 midterm");

    await expectNoA11yViolations(container);
  });

  test("empty queue", async () => {
    getMock.mockImplementation(() => Promise.resolve({ data: { items: [], total: 0 } }));

    const { container } = renderInMain(await loadApprovalQueuePage());
    await screen.findByText("Nothing is pending review.");

    await expectNoA11yViolations(container);
  });

  test("diff modal open", async () => {
    getMock.mockImplementation(() => Promise.resolve({ data: { items: [ITEM], total: 1 } }));

    const { container } = renderInMain(await loadApprovalQueuePage());
    await screen.findByText("Grade 9 Math — Q3 midterm");

    fireEvent.click(screen.getByRole("button", { name: "View diff" }));
    await screen.findByRole("dialog", { name: "What changed" });

    await expectNoA11yViolations(container);
  });

  test("reject-reason modal open", async () => {
    getMock.mockImplementation(() => Promise.resolve({ data: { items: [ITEM], total: 1 } }));

    const { container } = renderInMain(await loadApprovalQueuePage());
    await screen.findByText("Grade 9 Math — Q3 midterm");

    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await screen.findByRole("dialog", { name: "Reject item" });

    await expectNoA11yViolations(container);
  });

  test("bulk reject-reason modal open", async () => {
    getMock.mockImplementation(() => Promise.resolve({ data: { items: [ITEM], total: 1 } }));

    const { container } = renderInMain(await loadApprovalQueuePage());
    await screen.findByText("Grade 9 Math — Q3 midterm");

    fireEvent.click(screen.getByRole("checkbox", { name: "Select all pending items" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject 1 selected" }));
    await screen.findByRole("dialog", { name: "Reject selected items" });

    await expectNoA11yViolations(container);
  });
});
