import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { AuthProvider } from "../../../lib/auth";
import { expectNoA11yViolations } from "../../../lib/test/axe";
import { createTestSessionStore } from "../../../lib/test/session";

import type { ComponentType } from "react";

/**
 * Exam weeks: leadership lists a year's exam periods and the school's rooms, adds a period, opens
 * one to see its timetable and clashes, publishes it, generates an exam's seating and prints the
 * door sheets.
 */

const STAMP = { created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z" };
const YEAR = {
  id: "year-1",
  school_id: "school-1",
  code: "2026",
  name: "2026-2027",
  status: "active",
  starts_on: "2026-09-01",
  ends_on: "2027-06-30",
  ...STAMP,
};
const GRADE_10 = {
  id: "grade-10",
  school_id: "school-1",
  name: "Grade 10",
  sort_order: 10,
  ...STAMP,
};
const SECTION_A = {
  id: "sec-a",
  school_id: "school-1",
  academic_year_id: "year-1",
  grade_level_id: "grade-10",
  grade_level_name: "Grade 10",
  name: "A",
  student_count: 2,
  ...STAMP,
};
const HALL = {
  id: "room-hall",
  school_id: "school-1",
  code: "HALL",
  name: "Main hall",
  room_type: "physical",
  capacity: 40,
  exam_capacity: 20,
  building: "Block A",
  floor: null,
  virtual_url: null,
  is_active: true,
  ...STAMP,
};
const SUMMARY = {
  id: "period-1",
  academic_year_id: "year-1",
  term: null,
  name: "Term 1 finals",
  kind: "final",
  starts_on: "2026-12-07",
  ends_on: "2026-12-14",
  status: "draft",
  published_at: null,
  grade_levels: [{ id: "grade-10", name: "Grade 10" }],
  slot_count: 1,
  ...STAMP,
};
const MATH = {
  id: "slot-math",
  period_id: "period-1",
  subject: { id: "sub-math", code: "MATH", name: "Mathematics" },
  grade_level: { id: "grade-10", name: "Grade 10" },
  sections: [{ id: "sec-a", name: "A" }],
  exam_date: "2026-12-08",
  starts_at: "09:00",
  ends_at: "11:00",
  assessment: null,
  notes: null,
  rooms: [
    {
      id: "room-hall",
      code: "HALL",
      name: "Main hall",
      building: "Block A",
      floor: null,
      capacity: 20,
      seated: 2,
      invigilators: [{ id: "t-1", name: "Rana Saleh" }],
    },
  ],
  candidates: 2,
  seated: 2,
};
const PERIOD = { ...SUMMARY, slots: [MATH] };
const seat = (id: string, first: string, last: string, seatNumber: number) => ({
  student_id: id,
  first_name: first,
  last_name: last,
  admission_number: `A-${id}`,
  section: { id: "sec-a", name: "A" },
  room_id: "room-hall",
  seat_number: seatNumber,
});
const SEATING = {
  period_id: "period-1",
  slots: [
    {
      slot_id: "slot-math",
      seats: [seat("s-1", "Lina", "Haddad", 1), seat("s-2", "Sami", "Nasser", 2)],
      unseated: [],
    },
  ],
};
const CLASHES = {
  period_id: "period-1",
  clashes: [
    {
      type: "no_invigilator",
      severity: "warning",
      slot_ids: ["slot-math"],
      room_ids: ["room-hall"],
      teacher: null,
      students: [],
      seat_number: null,
      seated: null,
      capacity: null,
      count: null,
      holiday: null,
    },
  ],
};

const GET_RESPONSES: Record<string, unknown> = {
  "/api/academics/years": { academic_years: [YEAR], total: 1 },
  "/api/academics/years/{yearId}/terms": { terms: [], total: 0 },
  "/api/academics/grade-levels": { grade_levels: [GRADE_10], total: 1 },
  "/api/academics/sections": { sections: [SECTION_A], total: 1 },
  "/api/academics/subjects": {
    subjects: [{ id: "sub-math", code: "MATH", name: "Mathematics", ...STAMP }],
    total: 1,
  },
  "/api/academics/rooms": { rooms: [HALL], total: 1 },
  "/api/academics/exam-periods": { periods: [SUMMARY] },
  "/api/academics/exam-periods/{periodId}": PERIOD,
  "/api/academics/exam-periods/{periodId}/seating": SEATING,
  "/api/academics/exam-periods/{periodId}/clashes": CLASHES,
  "/api/grading/years/{yearId}/programs/{gradeLevelId}/subjects": { configs: [] },
  "/api/teachers": { teachers: [], next_cursor: null },
  "/api/users": { users: [], next_cursor: null },
};

const getMock = mock((path: string, _init?: unknown) =>
  Promise.resolve<unknown>({ data: GET_RESPONSES[path] }),
);
const postMock = mock((path: string, _init?: unknown) => {
  if (path === "/api/academics/exam-slots/{slotId}/seating") {
    return Promise.resolve<unknown>({ data: { ...SEATING.slots[0], kept: 0 } });
  }
  return Promise.resolve<unknown>({ data: PERIOD });
});
const putMock = mock((_path: string, _init?: unknown) =>
  Promise.resolve<unknown>({ data: { ...PERIOD, status: "published" } }),
);
const deleteMock = mock((_path: string, _init?: unknown) =>
  Promise.resolve<unknown>({ data: undefined }),
);
const patchMock = mock((_path: string, _init?: unknown) =>
  Promise.resolve<unknown>({ data: HALL }),
);
mock.module("../../../lib/api", () => ({
  api: { GET: getMock, POST: postMock, PUT: putMock, DELETE: deleteMock, PATCH: patchMock },
}));

async function renderAt(search: string) {
  const Page: ComponentType = (await import("./ExamWeeksPage")).default;
  const store = await createTestSessionStore(["PRINCIPAL"]);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <AuthProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <MemoryRouter initialEntries={[`/portal/principal/exam-weeks${search}`]}>
            <main>
              <Routes>
                <Route path="/portal/principal/exam-weeks" element={<Page />} />
              </Routes>
            </main>
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>
    </AuthProvider>,
  );
}

afterEach(() => {
  cleanup();
  postMock.mockClear();
  putMock.mockClear();
});

describe("ExamWeeksPage", () => {
  test("lists the year's exam periods and rooms, and adds a period", async () => {
    const { container } = await renderAt("?year=year-1");
    const open = await screen.findByRole("button", { name: "Open Term 1 finals" });
    const row = open.closest("tr")!;
    expect(within(row).getByText("Draft")).toBeTruthy();
    expect(within(row).getByText("Grade 10")).toBeTruthy();
    expect(await screen.findByText("Main hall")).toBeTruthy();
    expect(screen.getByText("20")).toBeTruthy();
    await expectNoA11yViolations(container);

    fireEvent.click(screen.getByRole("button", { name: "Add exam period" }));
    const save = await screen.findByRole("button", { name: "Save exam period" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Midterms" } });
    fireEvent.change(screen.getByLabelText(/^First day/), { target: { value: "2026-11-01" } });
    fireEvent.change(screen.getByLabelText(/^Last day/), { target: { value: "2026-11-05" } });
    fireEvent.click(await screen.findByLabelText("Grade 10"));
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    const [path, init] = postMock.mock.calls[0] as [string, { body: unknown }];
    expect(path).toBe("/api/academics/exam-periods");
    expect(init.body).toEqual({
      academic_year_id: "year-1",
      term_id: null,
      name: "Midterms",
      kind: "final",
      starts_on: "2026-11-01",
      ends_on: "2026-11-05",
      grade_level_ids: ["grade-10"],
      status: "draft",
    });
  });

  test("a period shows its timetable and clashes, and is published", async () => {
    const { container } = await renderAt("?year=year-1&period=period-1");
    expect(await screen.findByRole("heading", { name: "Term 1 finals" })).toBeTruthy();
    const seating = await screen.findByRole("button", { name: "Seating for Mathematics" });
    const row = seating.closest("tr")!;
    expect(within(row).getByText("Rana Saleh")).toBeTruthy();
    expect(within(row).getByText("2 of 2 seated")).toBeTruthy();
    expect(
      await screen.findByText(/Nobody invigilates Main hall: Mathematics \(Grade 10, 09:00\)/),
    ).toBeTruthy();
    await expectNoA11yViolations(container);

    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
    const [path, init] = putMock.mock.calls[0] as [string, { body: { status: string } }];
    expect(path).toBe("/api/academics/exam-periods/{periodId}");
    expect(init.body.status).toBe("published");
  });

  test("an exam's seating is generated with the chosen strategy", async () => {
    await renderAt("?year=year-1&period=period-1");
    fireEvent.click(await screen.findByRole("button", { name: "Seating for Mathematics" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Lina Haddad", { exact: false })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Generate seating" }));
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    const [path, init] = postMock.mock.calls[0] as [string, { body: unknown }];
    expect(path).toBe("/api/academics/exam-slots/{slotId}/seating");
    expect(init.body).toEqual({ strategy: "by_section", keep_existing: true });
  });

  test("door sheets list each room's seats for a sitting", async () => {
    await renderAt("?year=year-1&period=period-1");
    fireEvent.click(await screen.findByRole("button", { name: "Print door sheets" }));
    const sheet = await screen.findByRole("article");
    expect(within(sheet).getByText("Invigilators: Rana Saleh")).toBeTruthy();
    const rows = within(sheet).getAllByRole("row");
    expect(within(rows[1]!).getByText("Haddad, Lina")).toBeTruthy();
    expect(within(rows[2]!).getByText("Nasser, Sami")).toBeTruthy();
  });
});
