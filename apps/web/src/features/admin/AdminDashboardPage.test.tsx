import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";

import type { ComponentType } from "react";

const EMPTY_ATTENDANCE_TOTALS = {
  total_records: 0,
  present_count: 0,
  absent_count: 0,
  late_count: 0,
  excused_count: 0,
  present_percent: 0,
  absent_percent: 0,
  late_percent: 0,
  excused_percent: 0,
};

function emptyResponsesFor(path: string): Promise<{ data: unknown }> {
  switch (path) {
    case "/api/approvals/queue":
      return Promise.resolve({ data: { items: [], total: 0 } });
    case "/api/users/status-counts":
      return Promise.resolve({ data: { invited: 0, active: 0, suspended: 0, archived: 0 } });
    case "/api/attendance/reports/summary":
      return Promise.resolve({
        data: {
          generated_at: "2026-08-14T00:00:00.000Z",
          period: { term_id: null, start_date: "2026-08-14", end_date: "2026-08-14" },
          group_by: "class",
          totals: EMPTY_ATTENDANCE_TOTALS,
          items: [],
          pagination: { limit: 100, offset: 0, total: 0 },
        },
      });
    case "/api/subscriptions/current":
      return Promise.resolve({
        data: {
          subscription: {
            id: "sub-1",
            status: "active",
            currentPeriodStart: "2026-08-01T00:00:00.000Z",
            currentPeriodEnd: "2026-09-01T00:00:00.000Z",
            cancelAtPeriodEnd: false,
            cancellationRequestedAt: null,
            cancellationReason: null,
            retentionState: "none",
          },
          plan: { id: "plan-1", code: "growth", displayName: "Studafy Growth" },
          seats: { used: 7, cap: 20 },
          storage: { usedBytes: 524_288_000, capBytes: 1_048_576_000, fractionUsed: 0.5 },
        },
      });
    default:
      return Promise.resolve({ data: undefined });
  }
}

const getMock = mock((_path: string) => Promise.resolve<unknown>({ data: undefined }));
mock.module("../../lib/api", () => ({ api: { GET: getMock } }));

const loadAdminDashboardPage = async (): Promise<ComponentType> =>
  (await import("./AdminDashboardPage")).default;

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

describe("AdminDashboardPage", () => {
  test("renders live data from every tile's endpoint", async () => {
    getMock.mockImplementation((path: string) => {
      switch (path) {
        case "/api/approvals/queue":
          return Promise.resolve({ data: { items: [], total: 3 } });
        case "/api/users/status-counts":
          return Promise.resolve({ data: { invited: 5, active: 12, suspended: 0, archived: 0 } });
        case "/api/attendance/reports/summary":
          return Promise.resolve({
            data: {
              generated_at: "2026-08-14T00:00:00.000Z",
              period: { term_id: null, start_date: "2026-08-14", end_date: "2026-08-14" },
              group_by: "class",
              totals: {
                ...EMPTY_ATTENDANCE_TOTALS,
                total_records: 10,
                present_count: 8,
                present_percent: 80,
              },
              items: [],
              pagination: { limit: 100, offset: 0, total: 0 },
            },
          });
        case "/api/subscriptions/current":
          return Promise.resolve({
            data: {
              subscription: {
                id: "sub-1",
                status: "past_due",
                currentPeriodStart: "2026-08-01T00:00:00.000Z",
                currentPeriodEnd: "2026-09-01T00:00:00.000Z",
                cancelAtPeriodEnd: false,
                cancellationRequestedAt: null,
                cancellationReason: null,
                retentionState: "none",
              },
              plan: { id: "plan-1", code: "growth", displayName: "Studafy Growth" },
              seats: { used: 7, cap: 20 },
              storage: { usedBytes: 524_288_000, capBytes: 1_048_576_000, fractionUsed: 0.5 },
            },
          });
        default:
          return Promise.resolve({ data: undefined });
      }
    });

    renderPage(await loadAdminDashboardPage());

    expect(await screen.findByText("3")).toBeTruthy();
    expect(screen.getByText("Invited")).toBeTruthy();
    expect(screen.getByText("5")).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText("80%")).toBeTruthy();
    expect(screen.getByText("8 present of 10 records")).toBeTruthy();
    expect(screen.getByText("Past due")).toBeTruthy();
    expect(screen.getByText("Studafy Growth · 7/20 seats")).toBeTruthy();
    expect(screen.getByText("500.0 MB of 1000.0 MB used")).toBeTruthy();
  });

  test("renders each tile's empty state when there is nothing to show yet", async () => {
    getMock.mockImplementation(emptyResponsesFor);

    renderPage(await loadAdminDashboardPage());

    expect(await screen.findByText("Nothing is waiting on your review.")).toBeTruthy();
    expect(screen.getByText("No invited or active users yet.")).toBeTruthy();
    expect(screen.getByText("No attendance recorded yet today.")).toBeTruthy();
  });
});
