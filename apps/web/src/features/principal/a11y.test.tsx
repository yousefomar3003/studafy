import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import { expectNoA11yViolations } from "../../lib/test/axe";

import type { ComponentType } from "react";

/**
 * Automated accessibility audit for the principal dashboard (ST-195), mirroring
 * `admin/announcements/a11y.test.tsx` — one render per representative state inside a `<main>`,
 * matching how `RootLayout` wraps every route.
 */

const getMock = mock((_path: string) => Promise.resolve<unknown>({ data: undefined }));
mock.module("../../lib/api", () => ({ api: { GET: getMock } }));

const loadPrincipalDashboardPage = async (): Promise<ComponentType> =>
  (await import("./PrincipalDashboardPage")).default;
const loadAttendanceByClassPage = async (): Promise<ComponentType> =>
  (await import("./AttendanceByClassPage")).default;

function renderInPortal(Page: ComponentType) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <main>
          <Page />
        </main>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
});

describe("principal dashboard accessibility", () => {
  test("dashboard, empty state", async () => {
    getMock.mockImplementation((path: string) => {
      if (path === "/api/discipline/incidents") {
        return Promise.resolve({ data: { incidents: [], total: 0 } });
      }
      if (path === "/api/announcements") {
        return Promise.resolve({ data: { items: [], next_cursor: null } });
      }
      if (path === "/api/approvals/queue") {
        return Promise.resolve({ data: { items: [], total: 0 } });
      }
      return Promise.resolve({ data: undefined });
    });

    const { container } = renderInPortal(await loadPrincipalDashboardPage());
    await screen.findByRole("heading", { name: "Principal" });

    await expectNoA11yViolations(container);
  });

  test("attendance by class page", async () => {
    getMock.mockImplementation(() =>
      Promise.resolve({
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
          items: [],
          pagination: { limit: 100, offset: 0, total: 0 },
        },
      }),
    );

    const { container } = renderInPortal(await loadAttendanceByClassPage());
    await screen.findByRole("heading", { name: "Attendance by class" });

    await expectNoA11yViolations(container);
  });
});
