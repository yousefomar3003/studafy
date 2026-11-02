import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import type { ComponentType } from "react";

function summaryResponse(items: unknown[]) {
  return {
    data: {
      generated_at: "2026-08-17T00:00:00.000Z",
      period: { term_id: null, start_date: "2026-08-11", end_date: "2026-08-17" },
      group_by: "class",
      totals: {
        total_records: 0,
        present_count: 0,
        absent_count: 0,
        late_count: 0,
        excused_count: 0,
        present_percent: 0,
        absent_percent: 0,
        late_percent: 0,
        excused_percent: 0,
      },
      items,
      pagination: { limit: 100, offset: 0, total: items.length },
    },
  };
}

const getMock = mock((_path: string, _init?: { params?: { query?: unknown } }) =>
  Promise.resolve<unknown>(summaryResponse([])),
);
mock.module("../../lib/api", () => ({ api: { GET: getMock } }));

const loadAttendanceByClassPage = async (): Promise<ComponentType> =>
  (await import("./AttendanceByClassPage")).default;

function renderPage(Page: ComponentType, initialEntries?: string[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={initialEntries}>
        <Page />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
});

describe("AttendanceByClassPage", () => {
  test("renders every class's metrics", async () => {
    getMock.mockImplementation(() =>
      Promise.resolve(
        summaryResponse([
          {
            group_by: "class",
            class_id: "class-1",
            class_code: "G9-MATH",
            total_records: 20,
            present_count: 19,
            absent_count: 1,
            late_count: 0,
            excused_count: 0,
            present_percent: 95,
            absent_percent: 5,
            late_percent: 0,
            excused_percent: 0,
          },
        ]),
      ),
    );

    renderPage(await loadAttendanceByClassPage());

    expect(await screen.findByText("G9-MATH")).toBeTruthy();
    expect(screen.getByText("95%")).toBeTruthy();
  });

  test("a class_id query param filters the request and shows a clear-filter link", async () => {
    getMock.mockImplementation((_path: string, init?: { params?: { query?: unknown } }) => {
      const query = (init?.params?.query ?? {}) as { class_id?: string };
      if (query.class_id === "class-1") {
        return Promise.resolve(
          summaryResponse([
            {
              group_by: "class",
              class_id: "class-1",
              class_code: "G9-MATH",
              total_records: 20,
              present_count: 19,
              absent_count: 1,
              late_count: 0,
              excused_count: 0,
              present_percent: 95,
              absent_percent: 5,
              late_percent: 0,
              excused_percent: 0,
            },
          ]),
        );
      }
      return Promise.resolve(summaryResponse([]));
    });

    renderPage(await loadAttendanceByClassPage(), [
      "/portal/principal/attendance?class_id=class-1",
    ]);

    expect(await screen.findByText("G9-MATH")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Clear filter" })).toBeTruthy();
  });

  test("renders the empty state when nothing was recorded", async () => {
    getMock.mockImplementation(() => Promise.resolve(summaryResponse([])));

    renderPage(await loadAttendanceByClassPage());

    expect(await screen.findByText("No attendance recorded in this period.")).toBeTruthy();
  });
});
