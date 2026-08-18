import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- Bun provides this virtual test module.
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import { AuthProvider, createSessionStore } from "../../../../lib/auth";
import { expectNoA11yViolations } from "../../../../lib/test/axe";
import { attendanceMatrixFixture } from "../api/attendanceFixtures";
import { ThresholdBreachList } from "../components/ThresholdBreachList";
import { parseAttendanceFilters, serializeAttendanceFilters } from "../hooks/useAttendanceFilters";

import type { SessionTokens } from "../../../../lib/auth";
import type { ComponentType } from "react";

const METRICS = {
  total_records: 100,
  present_count: 82,
  absent_count: 12,
  late_count: 4,
  excused_count: 2,
  present_percent: 82,
  absent_percent: 12,
  late_percent: 4,
  excused_percent: 2,
};

const summaryResponse = {
  generated_at: "2026-08-18T08:00:00.000Z",
  period: { term_id: null, start_date: "2026-07-20", end_date: "2026-08-18" },
  group_by: "student",
  totals: METRICS,
  items: [],
  pagination: { limit: 500, offset: 0, total: 0 },
};
const trendResponse = {
  generated_at: "2026-08-18T08:00:00.000Z",
  period: summaryResponse.period,
  interval: "day",
  points: [
    { bucket_start: "2026-08-17", ...METRICS },
    { bucket_start: "2026-08-18", ...METRICS, present_percent: 88 },
  ],
};

const getMock = mock((path: string) => {
  if (path === "/api/attendance/reports/summary") return Promise.resolve({ data: summaryResponse });
  if (path === "/api/attendance/reports/trends") return Promise.resolve({ data: trendResponse });
  if (path.includes("/history"))
    return Promise.resolve({
      data: {
        record_id: "record-1",
        student_id: "student-1",
        attendance_session_id: "session-1",
        entries: [],
      },
    });
  if (path.includes("/export/")) return Promise.resolve({ data: exportJob });
  return Promise.resolve({ data: undefined });
});
const patchMock = mock((_path: string, _init?: { body?: Record<string, unknown> }) =>
  Promise.resolve({ data: { id: "record-1", status: "present" } }),
);
const exportJob = {
  id: "55555555-5555-4555-8555-555555555555",
  report_type: "attendance_summary",
  file_format: "xlsx",
  status: "completed",
  created_at: "2026-08-18T08:00:00.000Z",
  completed_at: "2026-08-18T08:00:01.000Z",
  download_url: "https://example.test/attendance.xlsx",
  download_url_expires_at: "2026-08-18T09:00:00.000Z",
  failure_message: null,
};
const postMock = mock((_path: string, _init?: { body?: Record<string, unknown> }) =>
  Promise.resolve({ data: exportJob }),
);

mock.module("../../../../lib/api", () => ({
  api: { GET: getMock, POST: postMock, PATCH: patchMock },
}));

function fakeJwt(payload: unknown): string {
  const segment = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${segment({ alg: "RS256" })}.${segment(payload)}.signature`;
}

async function renderWithRole(
  Page: ComponentType,
  role = "ORG_ADMIN",
  entry = "/portal/principal/attendance",
) {
  const store = createSessionStore({
    refreshClient: {
      refresh: async (): Promise<SessionTokens> => ({
        accessToken: fakeJwt({ roles: [role] }),
        expiresAt: Date.now() + 3_600_000,
        sessionId: "session-1",
      }),
      logout: async () => undefined,
    },
  });
  await store.restore();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <AuthProvider store={store}>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[entry]}>
          <Page />
        </MemoryRouter>
      </QueryClientProvider>
    </AuthProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
  postMock.mockClear();
  patchMock.mockClear();
});

describe("attendance filters", () => {
  test("round-trips bookmarkable dashboard state", () => {
    const filters = parseAttendanceFilters(
      new URLSearchParams(
        "view=class&start=2026-08-01&end=2026-08-18&grade=9&section_id=s1&status=late&interval=week&breaches=1",
      ),
    );
    expect(filters).toMatchObject({
      view: "class",
      grade: "9",
      sectionId: "s1",
      status: "late",
      interval: "week",
      breachesOnly: true,
    });
    expect(serializeAttendanceFilters(filters).get("status")).toBe("late");
  });
});

describe("ThresholdBreachList", () => {
  test("uses a strict unexcused absence threshold", () => {
    render(
      <ThresholdBreachList
        rows={attendanceMatrixFixture.slice(0, 4)}
        onSelectStudent={() => undefined}
      />,
    );
    expect(screen.getByText("Omar Saleh")).toBeTruthy();
    expect(screen.queryByText("Lina Nasser")).toBeNull();
    expect(screen.queryByText("Yousef Ali")).toBeNull();
  });
});

describe("AttendanceDashboardView", () => {
  test("reconciles summary metrics and filters the matrix from the URL", async () => {
    const Page = (await import("../views/AttendanceDashboardView")).default;
    await renderWithRole(Page, "ORG_ADMIN", "/portal/principal/attendance?status=absent&grade=10");
    expect(await screen.findByText("82.0%")).toBeTruthy();
    expect(screen.getByText("14")).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
    expect(await screen.findByText(/students in the active view/)).toBeTruthy();
    expect(screen.getAllByText("Absent").length).toBeGreaterThan(0);
  });

  test("opens student history and submits an authorized correction", async () => {
    const Page = (await import("../views/AttendanceDashboardView")).default;
    await renderWithRole(Page);
    fireEvent.click((await screen.findAllByRole("button", { name: "Omar Saleh" }))[0]!);
    expect(await screen.findByRole("dialog", { name: "Omar Saleh" })).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Request correction" })[0]!);
    expect(
      await screen.findByRole("dialog", { name: "Request attendance correction" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("combobox", { name: "Corrected status" }));
    fireEvent.click(screen.getByRole("option", { name: "Present" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Reason" }), {
      target: { value: "Teacher verified the student was present." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit correction" }));
    await waitFor(() => expect(patchMock).toHaveBeenCalled());
    expect(patchMock.mock.calls[0]?.[1]?.body).toMatchObject({
      status: "present",
      reason: "Teacher verified the student was present.",
    });
  });

  test("hides correction and export actions from a view-only role", async () => {
    const Page = (await import("../views/AttendanceDashboardView")).default;
    await renderWithRole(Page, "SUPPORT_AGENT");
    expect(await screen.findByText("Export unavailable")).toBeTruthy();
    fireEvent.click((await screen.findAllByRole("button", { name: "Amina Hassan" }))[0]!);
    expect(await screen.findAllByText("Read only")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Request correction" })).toBeNull();
  });

  test("starts a typed XLSX export with active filters", async () => {
    const Page = (await import("../views/AttendanceDashboardView")).default;
    await renderWithRole(
      Page,
      "ORG_ADMIN",
      "/portal/principal/attendance?grade=9&class_id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    fireEvent.click(await screen.findByRole("button", { name: "Export XLSX" }));
    await waitFor(() => expect(postMock).toHaveBeenCalled());
    expect(postMock.mock.calls[0]?.[1]?.body).toMatchObject({
      file_format: "xlsx",
      class_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    expect(await screen.findByRole("link", { name: "Download report" })).toBeTruthy();
  });

  test("has no automated accessibility violations in the populated dashboard", async () => {
    const Page = (await import("../views/AttendanceDashboardView")).default;
    const { container } = await renderWithRole(Page);
    await screen.findByRole("heading", { name: "Attendance monitoring" });
    await expectNoA11yViolations(container);
  });
});
