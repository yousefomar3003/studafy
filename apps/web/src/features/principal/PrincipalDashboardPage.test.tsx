import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import type { ComponentType } from "react";

const EMPTY_ATTENDANCE_SUMMARY = {
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
};

function emptyResponsesFor(path: string): Promise<{ data: unknown }> {
  switch (path) {
    case "/api/approvals/queue":
      return Promise.resolve({ data: { items: [], total: 0 } });
    case "/api/attendance/reports/summary":
      return Promise.resolve({ data: EMPTY_ATTENDANCE_SUMMARY });
    case "/api/discipline/incidents":
      return Promise.resolve({ data: { incidents: [], total: 0 } });
    case "/api/announcements":
      return Promise.resolve({ data: { items: [], next_cursor: null } });
    default:
      return Promise.resolve({ data: undefined });
  }
}

const getMock = mock((_path: string) => Promise.resolve<unknown>({ data: undefined }));
mock.module("../../lib/api", () => ({ api: { GET: getMock } }));

const loadPrincipalDashboardPage = async (): Promise<ComponentType> =>
  (await import("./PrincipalDashboardPage")).default;

function renderPage(Page: ComponentType) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Page />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
});

describe("PrincipalDashboardPage", () => {
  test("renders live data from every tile's endpoint", async () => {
    getMock.mockImplementation((path: string, init?: { params?: { query?: unknown } }) => {
      switch (path) {
        case "/api/approvals/queue":
          return Promise.resolve({ data: { items: [], total: 4 } });
        case "/api/attendance/reports/summary":
          return Promise.resolve({
            data: {
              ...EMPTY_ATTENDANCE_SUMMARY,
              items: [
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
              ],
            },
          });
        case "/api/discipline/incidents": {
          const query = (init?.params?.query ?? {}) as { status?: string };
          if (query.status === "reported") {
            return Promise.resolve({
              data: {
                total: 1,
                incidents: [
                  {
                    id: "incident-1",
                    school_id: "school-1",
                    student_id: "student-1",
                    class_id: null,
                    reporter_user_id: "user-1",
                    incident_type: "behavioral",
                    severity: "major",
                    status: "reported",
                    title: "Cafeteria altercation",
                    description: null,
                    incident_at: "2026-08-16T10:00:00.000Z",
                    resolved_at: null,
                    created_at: "2026-08-16T10:00:00.000Z",
                    updated_at: "2026-08-16T10:00:00.000Z",
                  },
                ],
              },
            });
          }
          return Promise.resolve({ data: { incidents: [], total: 0 } });
        }
        case "/api/announcements":
          return Promise.resolve({
            data: {
              items: [
                {
                  id: "announcement-1",
                  title: "Early dismissal Friday",
                  status: "published",
                  mandatory: false,
                  audience_type: "school",
                  audience_role: null,
                  audience_class_code: null,
                  scheduled_at: "2026-08-15T09:00:00.000Z",
                  published_at: "2026-08-15T09:00:00.000Z",
                  recipient_count: 500,
                  notified_count: 500,
                  created_by_name: "Jamie Chen",
                },
              ],
              next_cursor: null,
            },
          });
        default:
          return Promise.resolve({ data: undefined });
      }
    });

    renderPage(await loadPrincipalDashboardPage());

    expect(await screen.findByText("4")).toBeTruthy();
    expect(screen.getByText("G9-MATH")).toBeTruthy();
    expect(screen.getByText("95%")).toBeTruthy();
    expect(await screen.findByText("Cafeteria altercation")).toBeTruthy();
    expect(screen.getByText("Early dismissal Friday")).toBeTruthy();
  });

  test("renders each tile's empty state when there is nothing to show yet", async () => {
    getMock.mockImplementation(emptyResponsesFor);

    renderPage(await loadPrincipalDashboardPage());

    expect(await screen.findByText("Nothing is waiting on review.")).toBeTruthy();
    expect(screen.getByText("No attendance recorded in this window.")).toBeTruthy();
    expect(screen.getByText("No open incidents.")).toBeTruthy();
    expect(screen.getByText("No announcements published yet.")).toBeTruthy();
  });
});
