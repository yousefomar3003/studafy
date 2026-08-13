import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";

import type { ComponentType } from "react";

const getMock = mock((_path: string) =>
  Promise.resolve<unknown>({ data: { items: [], total: 0 } }),
);
mock.module("../../lib/api", () => ({ api: { GET: getMock } }));

const loadApprovalsPage = async (): Promise<ComponentType> =>
  (await import("./ApprovalsPage")).default;

function renderPage(Page: ComponentType) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <Page />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
});

describe("ApprovalsPage", () => {
  test("renders the pending items returned by the approval queue", async () => {
    getMock.mockImplementation(() =>
      Promise.resolve({
        data: {
          total: 1,
          items: [
            {
              id: "item-1",
              item_type: "grade_submission",
              status: "pending",
              summary: "Grade 9 Math — Q3 midterm",
              requested_by_user_id: "user-1",
              requested_by_display_name: "Jamie Chen",
              requested_at: "2026-08-01T12:00:00.000Z",
              decided_at: null,
              diff: {},
            },
          ],
        },
      }),
    );

    renderPage(await loadApprovalsPage());

    expect(await screen.findByText("Grade 9 Math — Q3 midterm")).toBeTruthy();
    expect(screen.getByText("Jamie Chen")).toBeTruthy();
  });

  test("renders an empty-state message when nothing is pending", async () => {
    getMock.mockImplementation(() => Promise.resolve({ data: { items: [], total: 0 } }));

    renderPage(await loadApprovalsPage());

    expect(await screen.findByText("Nothing is pending review.")).toBeTruthy();
  });
});
