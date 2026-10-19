import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { AuthProvider, createSessionStore } from "../../lib/auth";
import { expectNoA11yViolations } from "../../lib/test/axe";
import { todayIso } from "../principal/school/queries";

import type { SessionTokens } from "../../lib/auth";
import type { ComponentType } from "react";

const TODAY = todayIso();
const now = new Date();
const day = (offset: number) =>
  todayIso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset));

const session = (id: string, classId: string, status: string) => ({
  id,
  school_id: "school-1",
  class_id: classId,
  session_date: TODAY,
  period: null,
  status,
  taken_by_user_id: "user-1",
  created_at: `${TODAY}T08:00:00.000Z`,
  updated_at: `${TODAY}T08:00:00.000Z`,
});

/** Per-test API state the GET mock reads from. */
let sessions: ReturnType<typeof session>[] = [];
let records: { id: string; student_id: string; status: string; minutes_late: number | null }[] = [];

const metrics = (present: number, absent: number, late: number, excused: number) => {
  const total = present + absent + late + excused;
  const pct = (count: number) => (total === 0 ? 0 : (count / total) * 100);
  return {
    total_records: total,
    present_count: present,
    absent_count: absent,
    late_count: late,
    excused_count: excused,
    present_percent: pct(present),
    absent_percent: pct(absent),
    late_percent: pct(late),
    excused_percent: pct(excused),
  };
};

function summaryResponse(groupBy: string) {
  const items =
    groupBy === "student"
      ? [
          {
            group_by: "student",
            student_id: "s1",
            student_name: "Adam Saleh",
            admission_number: "ADM-1",
            ...metrics(5, 5, 0, 0),
          },
          {
            group_by: "student",
            student_id: "s2",
            student_name: "Bana Khoury",
            admission_number: "ADM-2",
            ...metrics(9, 0, 1, 0),
          },
        ]
      : [];
  return {
    generated_at: `${TODAY}T08:00:00.000Z`,
    period: { term_id: null, start_date: TODAY, end_date: TODAY },
    group_by: groupBy,
    attendance_alert_threshold: 75,
    totals: metrics(14, 5, 1, 0),
    items,
    pagination: { limit: 500, offset: 0, total: items.length },
  };
}

function getResponse(path: string, init?: unknown): { data?: unknown } {
  const query = (init as { params?: { query?: Record<string, unknown> } } | undefined)?.params
    ?.query;
  switch (path) {
    case "/api/attendance/reports/summary":
      return { data: summaryResponse(String(query?.group_by ?? "class")) };
    case "/api/attendance/reports/trends":
      return {
        data: {
          generated_at: `${TODAY}T08:00:00.000Z`,
          period: { term_id: "t1", start_date: day(-30), end_date: day(30) },
          interval: "week",
          points: [],
        },
      };
    case "/api/students/{studentId}":
      return {
        data: {
          id: "s1",
          first_name: "Adam",
          last_name: "Saleh",
          preferred_name: null,
          admission_number: "ADM-1",
        },
      };
    case "/api/attendance/students/{studentId}/records":
      return {
        data: {
          student_id: "s1",
          records: [
            {
              id: "r9",
              attendance_session_id: "sess-9",
              session_date: TODAY,
              period: null,
              class_id: "c1",
              class_code: "MATH-A",
              status: "absent",
              minutes_late: null,
              reason: "Sick",
            },
          ],
        },
      };
    case "/api/academics/years":
      return {
        data: {
          academic_years: [
            { id: "y1", name: "2026", status: "active", starts_on: day(-60), ends_on: day(60) },
          ],
          total: 1,
        },
      };
    case "/api/academics/years/{yearId}/terms":
      return {
        data: {
          terms: [{ id: "t1", name: "Term 1", starts_on: day(-30), ends_on: day(30) }],
          total: 1,
        },
      };
    case "/api/academics/classes":
      return {
        data: {
          classes: [
            { id: "c1", code: "MATH-A", status: "active" },
            { id: "c2", code: "SCI-B", status: "active" },
            { id: "c3", code: "ART-C", status: "active" },
          ],
          total: 3,
        },
      };
    case "/api/academics/classes/{classId}":
      return { data: { id: "c1", code: "MATH-A", status: "active" } };
    case "/api/attendance/sessions":
      return { data: { attendance_sessions: sessions, total: sessions.length } };
    case "/api/academics/classes/{classId}/enrollments":
      return {
        data: {
          enrollments: [
            { student_id: "s1", class_id: "c1", status: "active" },
            { student_id: "s2", class_id: "c1", status: "active" },
          ],
          total: 2,
        },
      };
    case "/api/students":
      return {
        data: {
          students: [
            { id: "s1", first_name: "Adam", last_name: "Saleh", preferred_name: null },
            { id: "s2", first_name: "Bana", last_name: "Khoury", preferred_name: null },
          ],
          next_cursor: null,
        },
      };
    case "/api/attendance/sessions/{sessionId}/records":
      return { data: { attendance_session_id: "sess-1", records } };
    default:
      return { data: undefined };
  }
}

const getMock = mock((path: string, init?: unknown) => Promise.resolve(getResponse(path, init)));
const postMock = mock((path: string, _init?: unknown) =>
  Promise.resolve(
    path === "/api/attendance/sessions"
      ? { data: session("sess-new", "c1", "open") }
      : { data: {} },
  ),
);
const patchMock = mock((_path: string, _init?: unknown) => Promise.resolve({ data: {} }));
mock.module("../../lib/api", () => ({ api: { GET: getMock, POST: postMock, PATCH: patchMock } }));

function fakeJwt(payload: unknown): string {
  const segment = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${segment({ alg: "RS256" })}.${segment(payload)}.signature`;
}

async function renderAt(url: string, role = "ATTENDANCE_OFFICER") {
  const OfficePage: ComponentType = (await import("./AttendanceOfficePage")).default;
  const RegisterPage: ComponentType = (await import("./RegisterPage")).default;
  const StudentPage: ComponentType = (await import("./StudentAttendancePage")).default;
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
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <AuthProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <MemoryRouter initialEntries={[url]}>
            <main>
              <Routes>
                <Route path="/portal/attendance" element={<OfficePage />} />
                <Route path="/portal/attendance/register/:classId" element={<RegisterPage />} />
                <Route path="/portal/attendance/students/:studentId" element={<StudentPage />} />
              </Routes>
            </main>
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>
    </AuthProvider>,
  );
}

beforeEach(() => {
  sessions = [];
  records = [];
  getMock.mockClear();
  postMock.mockClear();
  patchMock.mockClear();
});

afterEach(cleanup);

describe("AttendanceOfficePage", () => {
  test("shows each class's register state for the day and counts what is outstanding", async () => {
    sessions = [session("sess-2", "c2", "open"), session("sess-3", "c3", "submitted")];
    await renderAt("/portal/attendance");

    const mathRow = (await screen.findByText("MATH-A")).closest("tr")!;
    expect(within(mathRow).getByText("Not started")).toBeTruthy();
    expect(within(mathRow).getByRole("link", { name: "Take attendance for MATH-A" })).toBeTruthy();

    const scienceRow = screen.getByText("SCI-B").closest("tr")!;
    expect(within(scienceRow).getByText("In progress")).toBeTruthy();

    const artRow = screen.getByText("ART-C").closest("tr")!;
    expect(within(artRow).getByText("Submitted")).toBeTruthy();

    expect(screen.getByText("1 not started")).toBeTruthy();
    expect(screen.getByText("1 in progress")).toBeTruthy();
    expect(screen.getByText("1 submitted")).toBeTruthy();
  });
});

describe("attendance dashboard", () => {
  test("a teacher sees registers read-only: no taking, only viewing what exists", async () => {
    sessions = [session("sess-3", "c3", "submitted")];
    await renderAt("/portal/attendance", "INSTRUCTOR");

    const mathRow = (await screen.findByText("MATH-A")).closest("tr")!;
    expect(within(mathRow).getByText("Not taken yet")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Take attendance/ })).toBeNull();
    expect(screen.getByRole("link", { name: "View the register for ART-C" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Attendance reports" })).toBeNull();
  });

  test("shows the day's numbers and lists students below the alert threshold", async () => {
    await renderAt("/portal/attendance");

    // The day's tiles: 14 present, 5 absent, 1 late out of 20 records.
    const dayHeading = await screen.findByRole("heading", { name: `Attendance on ${TODAY}` });
    const daySection = dayHeading.closest("section")!;
    expect(await within(daySection).findByText("14")).toBeTruthy();
    expect(within(daySection).getByText("5")).toBeTruthy();
    const atRisk = await screen.findByRole("table", { name: "Students below the alert threshold" });
    await within(atRisk).findByRole("link", { name: "Adam Saleh" });
    expect(within(atRisk).queryByRole("link", { name: "Bana Khoury" })).toBeNull();
  });

  test("searching for a student links to their attendance profile", async () => {
    await renderAt("/portal/attendance");
    const searchbox = await screen.findByRole("searchbox", { name: "Search students" });
    fireEvent.change(searchbox, { target: { value: "Adam" } });
    const results = searchbox.closest(".attendance-office__search") as HTMLElement;
    const link = await within(results).findByRole("link", { name: "Adam Saleh" });
    expect(link.getAttribute("href")).toBe("/portal/attendance/students/s1");
  });
});

describe("StudentAttendancePage", () => {
  test("shows the student's term numbers and session history", async () => {
    await renderAt("/portal/attendance/students/s1", "PRINCIPAL");

    expect(await screen.findByRole("heading", { name: "Adam Saleh", level: 1 })).toBeTruthy();
    const history = await screen.findByRole("table", { name: "Attendance history" });
    const row = (await within(history).findByText("MATH-A")).closest("tr")!;
    expect(within(row).getByText("Absent")).toBeTruthy();
    expect(within(row).getByText("Sick")).toBeTruthy();
  });
});

describe("RegisterPage", () => {
  test("a teacher sees the register read-only, without taking or correcting", async () => {
    sessions = [{ ...session("sess-1", "c1", "submitted") }];
    records = [{ id: "r1", student_id: "s1", status: "present", minutes_late: null }];
    await renderAt(`/portal/attendance/register/c1?date=${TODAY}`, "INSTRUCTOR");

    await screen.findByText("Adam Saleh");
    expect(
      screen.getByText("View-only. Registers are taken by the attendance office."),
    ).toBeTruthy();
    expect(screen.getByText("Not recorded")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Correct the record/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Submit register/ })).toBeNull();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
  });

  test("submits a fresh register: opens the session, records every student, submits it", async () => {
    await renderAt(`/portal/attendance/register/c1?date=${TODAY}`);

    const banaRow = (await screen.findByText("Bana Khoury")).closest("tr")!;
    fireEvent.click(within(banaRow).getByRole("radio", { name: "Absent" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit register (2 students)" }));

    await waitFor(() => expect(patchMock).toHaveBeenCalled());
    expect(postMock.mock.calls[0]).toEqual([
      "/api/attendance/sessions",
      { body: { class_id: "c1", session_date: TODAY } },
    ]);
    expect(postMock.mock.calls[1]).toEqual([
      "/api/attendance/records/batch",
      {
        body: {
          attendance_session_id: "sess-new",
          records: [
            { student_id: "s1", status: "present" },
            { student_id: "s2", status: "absent" },
          ],
        },
      },
    ]);
    expect(patchMock.mock.calls[0]).toEqual([
      "/api/attendance/sessions/{sessionId}",
      { params: { path: { sessionId: "sess-new" } }, body: { status: "submitted" } },
    ]);
  });

  test("refuses to submit a late mark without minutes", async () => {
    await renderAt(`/portal/attendance/register/c1?date=${TODAY}`);

    const adamRow = (await screen.findByText("Adam Saleh")).closest("tr")!;
    fireEvent.click(within(adamRow).getByRole("radio", { name: "Late" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit register (2 students)" }));

    expect(
      await screen.findByText("Enter minutes late for every student marked late."),
    ).toBeTruthy();
    expect(postMock).not.toHaveBeenCalled();
  });

  test("a submitted register is read-only with a correction per record", async () => {
    sessions = [{ ...session("sess-1", "c1", "submitted") }];
    records = [
      { id: "r1", student_id: "s1", status: "present", minutes_late: null },
      { id: "r2", student_id: "s2", status: "late", minutes_late: 10 },
    ];
    await renderAt(`/portal/attendance/register/c1?date=${TODAY}`);

    expect(
      await screen.findByRole("button", { name: "Correct the record for Bana Khoury" }),
    ).toBeTruthy();
    expect(screen.getByText("10 minutes late")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Submit register/ })).toBeNull();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
  });
});

describe("RegisterPage — fully recorded but not submitted", () => {
  test("offers to submit an open register whose students are all recorded", async () => {
    sessions = [{ ...session("sess-1", "c1", "open") }];
    records = [
      { id: "r1", student_id: "s1", status: "present", minutes_late: null },
      { id: "r2", student_id: "s2", status: "absent", minutes_late: null },
    ];
    await renderAt(`/portal/attendance/register/c1?date=${TODAY}`);

    fireEvent.click(await screen.findByRole("button", { name: "Submit register" }));

    await waitFor(() => expect(patchMock).toHaveBeenCalled());
    expect(postMock).not.toHaveBeenCalled();
    expect(patchMock.mock.calls[0]).toEqual([
      "/api/attendance/sessions/{sessionId}",
      { params: { path: { sessionId: "sess-1" } }, body: { status: "submitted" } },
    ]);
  });
});

describe("attendance office accessibility", () => {
  test("the overview has no axe violations", async () => {
    const { container } = await renderAt("/portal/attendance");
    await screen.findByText("MATH-A");
    await expectNoA11yViolations(container);
  });

  test("an open register has no axe violations", async () => {
    const { container } = await renderAt(`/portal/attendance/register/c1?date=${TODAY}`);
    await screen.findByText("Bana Khoury");
    await expectNoA11yViolations(container);
  });
});
