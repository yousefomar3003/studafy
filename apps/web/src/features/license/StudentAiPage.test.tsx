import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";

import { admissionNumbersFromCsv, firstOfNextMonth } from "./StudentAiPage";
import { renderAs } from "./test-utils";

import type { ComponentType } from "react";

/**
 * Student AI opt-in on the school's side: the seats, the minimum, the price parents see and what
 * opting in today costs; why a window can't be opened; students waiting for a seat and the seat
 * request Studafy was sent; opening a window (only after accepting the minimum) and closing it;
 * recording parents' choices on their behalf (a note is required), one by one, selected or from a
 * CSV of admission numbers; transferring or releasing the seat of a student who left (and of no one
 * else); and no controls without license:manage.
 */

const LICENSE_ID = "11111111-1111-4111-8111-111111111111";
const WINDOW_ID = "22222222-2222-4222-8222-222222222222";
const YEAR_ID = "33333333-3333-4333-8333-333333333333";
const GRADE_ID = "44444444-4444-4444-8444-444444444444";
const ADMIN = { userId: "55555555-5555-4555-8555-555555555555", name: "Huda Admin" };

const students = {
  sara: "a0000000-0000-4000-8000-000000000001",
  omar: "a0000000-0000-4000-8000-000000000002",
  lina: "a0000000-0000-4000-8000-000000000003",
  noor: "a0000000-0000-4000-8000-000000000004",
  zaid: "a0000000-0000-4000-8000-000000000005",
  maha: "a0000000-0000-4000-8000-000000000006",
  rami: "a0000000-0000-4000-8000-000000000007",
};

function optIn(studentId: string, studentName: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `o-${studentId.slice(-1)}`,
    studentId,
    studentName,
    academicYearId: YEAR_ID,
    licenseId: LICENSE_ID,
    windowId: WINDOW_ID,
    source: "parent",
    parent: { userId: "p-1", name: "A parent" },
    recordedBy: { userId: "p-1", name: "A parent" },
    note: null,
    termsVersion: "2026-11",
    optedInAt: "2026-11-02T08:00:00.000Z",
    startMonth: "2026-11-01",
    endMonth: "2027-06-01",
    months: 8,
    currencyCode: "USD",
    minorUnit: 2,
    monthlyPriceMinor: 600,
    totalMinor: 4800,
    seatId: `seat-${studentId.slice(-1)}`,
    seatAssignedAt: "2026-11-02T08:00:00.000Z",
    status: "active",
    endedAt: null,
    endNote: null,
    releasedEffectiveMonth: null,
    transferredToId: null,
    transferredFromId: null,
    ...overrides,
  };
}

function row(
  studentId: string,
  name: string,
  admissionNumber: string,
  extra: { studentStatus?: string; eligible?: boolean; optIn?: unknown } = {},
) {
  return {
    studentId,
    name,
    admissionNumber,
    studentStatus: extra.studentStatus ?? "enrolled",
    gradeLevelName: "Grade 7",
    sectionName: "A",
    eligible: extra.eligible ?? true,
    optIn: extra.optIn ?? null,
  };
}

const rows = [
  row(students.sara, "Sara Ali", "A-001", { optIn: optIn(students.sara, "Sara Ali") }),
  row(students.omar, "Omar Saleh", "A-002", {
    optIn: optIn(students.omar, "Omar Saleh", {
      source: "school_on_behalf",
      parent: null,
      recordedBy: ADMIN,
      note: "Told us at pickup",
      seatId: null,
      seatAssignedAt: null,
    }),
  }),
  row(students.lina, "Lina Haddad", "A-003", {
    studentStatus: "withdrawn",
    eligible: false,
    optIn: optIn(students.lina, "Lina Haddad"),
  }),
  row(students.noor, "Noor Aziz", "A-004"),
  row(students.zaid, "Zaid Kamal", "A-005"),
  row(students.maha, "Maha Nasser", "A-006", {
    studentStatus: "graduated",
    eligible: false,
    optIn: optIn(students.maha, "Maha Nasser", {
      status: "released",
      seatId: null,
      releasedEffectiveMonth: "2026-12-01",
    }),
  }),
  row(students.rami, "Rami Odeh", "A-007", {
    optIn: optIn(students.rami, "Rami Odeh", { source: "transfer", status: "transferred" }),
  }),
];

function openWindow(overrides: Record<string, unknown> = {}) {
  return {
    id: WINDOW_ID,
    licenseId: LICENSE_ID,
    academicYear: { id: YEAR_ID, name: "2026–2027", startsOn: "2026-09-01", endsOn: "2027-06-30" },
    opensOn: "2026-11-01",
    closesOn: "2026-11-30",
    state: "open",
    note: "Autumn enrolment",
    gradeLevels: [{ id: GRADE_ID, name: "Grade 7" }],
    sections: [],
    openedBy: ADMIN,
    openedAt: "2026-11-01T07:00:00.000Z",
    closedBy: null,
    closedAt: null,
    ...overrides,
  };
}

let overviewExtra: Record<string, unknown> = {};

function overview() {
  return {
    license: {
      id: LICENSE_ID,
      status: "active",
      studentSeats: 50,
      assignedStudentSeats: 40,
      commitment: "full_year",
    },
    programme: { currencyCode: "USD", minorUnit: 2, monthlyPriceMinor: 600, minSeats: 30 },
    window: openWindow(),
    pricingToday: { startMonth: "2026-11-01", endMonth: "2027-06-01", months: 8, totalMinor: 4800 },
    counts: { eligible: 100, optedIn: 12, waitingForSeat: 0, released: 1, transferred: 1 },
    seatsNeeded: 30,
    openSeatRequest: null,
    blocker: null,
    termsVersion: "2026-11",
    today: "2026-11-17",
    ...overviewExtra,
  };
}

interface Init {
  params?: { query?: Record<string, unknown>; path?: Record<string, string> };
  body?: Record<string, unknown>;
}

const getMock = mock((path: string, init?: Init) => {
  switch (path) {
    case "/api/school/license/student-ai":
      return Promise.resolve({ data: overview() });
    case "/api/school/license/student-ai/students": {
      const filter = init?.params?.query?.filter;
      const list =
        filter === "not_opted_in"
          ? rows.filter((r) => r.studentStatus === "enrolled" && r.optIn === null)
          : rows;
      return Promise.resolve({ data: { students: list, total: list.length, filter } });
    }
    case "/api/school/license":
      return Promise.resolve({ data: { license: null, usage: [], openChangeRequests: [] } });
    case "/api/school/license/invoices":
      return Promise.resolve({ data: { invoices: [], status: "overdue" } });
    case "/api/academics/years":
      return Promise.resolve({
        data: {
          academic_years: [
            {
              id: YEAR_ID,
              status: "active",
              starts_on: "2026-09-01",
              ends_on: "2027-06-30",
              name: "2026–2027",
            },
          ],
          total: 1,
        },
      });
    case "/api/academics/grade-levels":
      return Promise.resolve({ data: { grade_levels: [{ id: GRADE_ID, name: "Grade 7" }] } });
    case "/api/academics/sections":
      return Promise.resolve({ data: { sections: [], total: 0 } });
    default:
      throw new Error(`Unhandled GET ${path}`);
  }
});

let recordResult: unknown = { recorded: [], notRecorded: [] };

const postMock = mock((path: string, init?: Init) => {
  switch (path) {
    case "/api/school/license/student-ai/windows":
      return Promise.resolve({ data: openWindow({ ...init!.body }) });
    case "/api/school/license/student-ai/windows/{windowId}/close":
      return Promise.resolve({ data: openWindow({ state: "closed" }) });
    case "/api/school/license/student-ai/opt-ins":
      return Promise.resolve({ data: recordResult });
    case "/api/school/license/student-ai/opt-ins/{optInId}/transfer":
      return Promise.resolve({
        data: {
          from: optIn(students.lina, "Lina Haddad", { status: "transferred" }),
          to: optIn(students.noor, "Noor Aziz", { source: "transfer" }),
        },
      });
    case "/api/school/license/student-ai/opt-ins/{optInId}/release":
      return Promise.resolve({
        data: optIn(students.lina, "Lina Haddad", {
          status: "released",
          releasedEffectiveMonth: "2026-12-01",
        }),
      });
    default:
      throw new Error(`Unhandled POST ${path}`);
  }
});

mock.module("../../lib/api", () => ({ api: { GET: getMock, POST: postMock } }));

const loadPage = async (): Promise<ComponentType> => (await import("./StudentAiPage")).default;

async function renderPage(role = "PRINCIPAL") {
  const Page = await loadPage();
  return renderAs(role, <Page />, {
    path: "/portal/license/student-ai",
    at: "/portal/license/student-ai",
  });
}

function bodiesOf(path: string) {
  return postMock.mock.calls.filter(([p]) => p === path).map(([, init]) => init!.body!);
}

async function table() {
  return within(await screen.findByRole("table", { name: "Students" }));
}

async function rowOf(name: string) {
  return (await (await table()).findByText(name)).closest("tr")!;
}

function fact(label: string) {
  return screen.getByText(label, { selector: "dt" }).parentElement!.querySelector("dd")!
    .textContent;
}

afterEach(() => {
  cleanup();
  overviewExtra = {};
  recordResult = { recorded: [], notRecorded: [] };
  getMock.mockClear();
  postMock.mockClear();
});

describe("StudentAiPage", () => {
  test("shows the seats, how it's billed, the price parents see, what opting in costs and who did", async () => {
    await renderPage();
    expect((await screen.findByTestId("student-ai-seats")).textContent).toBe("40 of 50 assigned");
    expect(screen.getByTestId("student-ai-billing").textContent).toBe(
      "Month by month, as parents pay — no minimum seats",
    );
    expect(screen.getByTestId("student-ai-price").textContent).toBe("$6.00 a month");
    const today = screen.getByTestId("student-ai-today").textContent;
    expect(today).toContain("$6.00 × 8 months = $48.00");
    expect(today).toContain("November 2026 to June 2027, paid with tuition");
    expect(fact("Commitment")).toBe("Full year committed");
    expect(fact("Opted in")).toBe("12 of 100 eligible students");
    expect(fact("Conversion")).toBe("12%");

    const window = screen.getByTestId("student-ai-window");
    expect(within(window).getByText("Open")).toBeTruthy();
    expect(window.textContent).toContain("Grade 7");
    expect(window.textContent).toContain("Huda Admin on Nov 1, 2026");
    // No blocker, and no minimum or seat request any more (programme seats, 000252).
    expect(screen.queryByTestId("student-ai-blocker")).toBeNull();
    expect(screen.queryByTestId("seat-request")).toBeNull();
  });

  test("says why a window can't be opened, and offers none", async () => {
    overviewExtra = { blocker: "no_price", window: null, pricingToday: null };
    await renderPage();
    const blocker = await screen.findByTestId("student-ai-blocker");
    expect(blocker.textContent).toContain(
      "Studafy hasn't set the price parents see in your school's currency yet.",
    );
    expect(screen.queryByRole("button", { name: "Open opt-in window" })).toBeNull();
    expect(
      screen.getByText(
        "No opt-in window yet. Open one so parents can choose Student AI in the app.",
      ),
    ).toBeTruthy();
  });

  test("opening a window explains month-by-month billing, with no minimum to accept", async () => {
    overviewExtra = { window: null };
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Open opt-in window" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Open an opt-in window" }));
    expect(dialog.getByTestId("programme-billing").textContent).toContain(
      "Billed month by month, as parents pay",
    );
    expect((dialog.getByLabelText("Opens on") as HTMLInputElement).value).toBe("2026-11-17");
    fireEvent.change(dialog.getByLabelText("Closes on"), { target: { value: "2026-12-15" } });
    fireEvent.click(await dialog.findByLabelText("Grade 7"));

    const submit = dialog.getByRole("button", { name: "Open window" }) as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(bodiesOf("/api/school/license/student-ai/windows")).toHaveLength(1));
    expect(bodiesOf("/api/school/license/student-ai/windows")[0]).toEqual({
      academicYearId: YEAR_ID,
      opensOn: "2026-11-17",
      closesOn: "2026-12-15",
      gradeLevelIds: [GRADE_ID],
      sectionIds: undefined,
      note: undefined,
    });
    expect(await screen.findByText("Opt-in window opened.")).toBeTruthy();
  });

  test("a window that closes before it opens is refused", async () => {
    overviewExtra = { window: null };
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Open opt-in window" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Open an opt-in window" }));
    fireEvent.change(dialog.getByLabelText("Closes on"), { target: { value: "2026-11-01" } });
    expect(dialog.getByText("The window must close on or after the day it opens.")).toBeTruthy();
    expect(
      (dialog.getByRole("button", { name: "Open window" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  test("closes the window after a confirmation", async () => {
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Close window" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Close the opt-in window?" }));
    fireEvent.click(dialog.getByRole("button", { name: "Close window" }));
    await waitFor(() =>
      expect(
        postMock.mock.calls.find(
          ([path]) => path === "/api/school/license/student-ai/windows/{windowId}/close",
        )?.[1]?.params?.path,
      ).toEqual({ windowId: WINDOW_ID }),
    );
    expect(await screen.findByText("Opt-in window closed.")).toBeTruthy();
  });

  test("badges say who opted each student in, who waits, and who was released or transferred", async () => {
    await renderPage();
    expect(within(await rowOf("Sara Ali")).getByText("Opted in by parent")).toBeTruthy();
    expect(within(await rowOf("Sara Ali")).getByText("$6.00 × 8 months = $48.00")).toBeTruthy();
    const omar = await rowOf("Omar Saleh");
    expect(within(omar).getByText("Recorded by school")).toBeTruthy();
    expect(within(omar).getByText("Waiting for a seat")).toBeTruthy();
    const lina = await rowOf("Lina Haddad");
    expect(within(lina).getByText("Opted in by parent")).toBeTruthy();
    expect(within(lina).getByText("Left the school")).toBeTruthy();
    expect(
      within(await rowOf("Maha Nasser")).getByText("Released from December 2026"),
    ).toBeTruthy();
    expect(within(await rowOf("Rami Odeh")).getByText("Transferred")).toBeTruthy();
    expect(within(await rowOf("Noor Aziz")).getByText("Not opted in")).toBeTruthy();
  });

  test("records a selection on the parents' behalf; the note is required", async () => {
    recordResult = {
      recorded: [optIn(students.noor, "Noor Aziz", { source: "school_on_behalf" })],
      notRecorded: [{ studentId: students.zaid, reference: students.zaid, reason: "not_eligible" }],
    };
    await renderPage();
    const list = await table();
    await list.findByText("Noor Aziz");
    // Students who already opted in can't be selected.
    expect(list.queryByRole("checkbox", { name: "Select Sara Ali" })).toBeNull();
    fireEvent.click(list.getByRole("checkbox", { name: "Select Noor Aziz" }));
    fireEvent.click(list.getByRole("checkbox", { name: "Select Zaid Kamal" }));
    fireEvent.click(screen.getByRole("button", { name: "Record on parents' behalf (2 selected)" }));

    const dialog = within(
      await screen.findByRole("dialog", {
        name: "Record Student AI for 2 students on their parents' behalf",
      }),
    );
    const price = dialog.getByTestId("record-price").textContent;
    expect(price).toContain("Each student: $6.00 × 8 months = $48.00.");
    expect(price).toContain("Total for 2 students: $96.00.");
    expect(price).toContain("can't be cancelled mid-year");

    const record = dialog.getByRole("button", { name: "Record" }) as HTMLButtonElement;
    expect(record.disabled).toBe(true);
    fireEvent.change(dialog.getByLabelText(/How did the parent tell the school/), {
      target: { value: "   " },
    });
    expect(record.disabled).toBe(true);
    fireEvent.change(dialog.getByLabelText(/How did the parent tell the school/), {
      target: { value: "Signed the enrolment form" },
    });
    await waitFor(() => expect(record.disabled).toBe(false));
    fireEvent.click(record);

    await waitFor(() =>
      expect(bodiesOf("/api/school/license/student-ai/opt-ins")).toEqual([
        { studentIds: [students.noor, students.zaid], note: "Signed the enrolment form" },
      ]),
    );
    const report = await screen.findByRole("status", { name: "1 opt-in recorded." });
    expect(
      within(
        within(report).getByRole("list", { name: "1 student isn't in this window:" }),
      ).getByText("Zaid Kamal"),
    ).toBeTruthy();
  });

  test("imports a CSV column of admission numbers and reports who wasn't found", async () => {
    recordResult = {
      recorded: [optIn(students.noor, "Noor Aziz", { source: "school_on_behalf" })],
      notRecorded: [{ studentId: null, reference: "A-999", reason: "not_found" }],
    };
    await renderPage();
    await (await table()).findByText("Noor Aziz");
    const csv = "Name,Admission number\nNoor Aziz,A-004\nGhost,A-999\nNoor again,A-004\n";
    fireEvent.change(screen.getByLabelText("CSV file of admission numbers"), {
      target: { files: [new File([csv], "choices.csv", { type: "text/csv" })] },
    });

    const dialog = within(
      await screen.findByRole("dialog", {
        name: "Record Student AI for 2 students on their parents' behalf",
      }),
    );
    expect(dialog.getByTestId("csv-summary").textContent).toBe(
      "2 admission numbers found in choices.csv.",
    );
    fireEvent.change(dialog.getByLabelText(/How did the parent tell the school/), {
      target: { value: "Paper forms, November" },
    });
    fireEvent.click(dialog.getByRole("button", { name: "Record" }));

    await waitFor(() =>
      expect(bodiesOf("/api/school/license/student-ai/opt-ins")).toEqual([
        { admissionNumbers: ["A-004", "A-999"], note: "Paper forms, November" },
      ]),
    );
    const missing = await screen.findByRole("list", {
      name: "1 admission number wasn't found:",
    });
    expect(within(missing).getByText("A-999")).toBeTruthy();
  });

  test("only a student who left can have their seat transferred or released", async () => {
    await renderPage();
    const sara = await rowOf("Sara Ali");
    expect(within(sara).queryByRole("button", { name: /Transfer|Release/ })).toBeNull();
    const lina = await rowOf("Lina Haddad");
    expect(
      within(lina).getByRole("button", { name: "Transfer the seat of Lina Haddad" }),
    ).toBeTruthy();
    expect(
      within(lina).getByRole("button", { name: "Release the seat of Lina Haddad" }),
    ).toBeTruthy();
    // A released seat has nothing left to move.
    expect(within(await rowOf("Maha Nasser")).queryByRole("button")).toBeNull();
  });

  test("releases a left student's seat: no longer charged from next month", async () => {
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Release the seat of Lina Haddad" }));
    const dialog = within(
      await screen.findByRole("dialog", { name: "Release Lina Haddad's seat" }),
    );
    expect(dialog.getByTestId("release-effective").textContent).toBe(
      "No longer charged from December 2026. The seat is freed.",
    );
    const confirm = dialog.getByRole("button", { name: "Release seat" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(dialog.getByLabelText(/Note/), { target: { value: "Moved abroad" } });
    await waitFor(() => expect(confirm.disabled).toBe(false));
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(bodiesOf("/api/school/license/student-ai/opt-ins/{optInId}/release")).toEqual([
        { note: "Moved abroad" },
      ]),
    );
    expect(
      await screen.findByText(
        "Lina Haddad's seat was released. No longer charged from December 2026.",
      ),
    ).toBeTruthy();
  });

  test("transfers a left student's seat to an enrolled student without Student AI", async () => {
    await renderPage();
    fireEvent.click(
      await screen.findByRole("button", { name: "Transfer the seat of Lina Haddad" }),
    );
    const dialog = within(
      await screen.findByRole("dialog", { name: "Transfer Lina Haddad's seat" }),
    );
    fireEvent.click(await dialog.findByLabelText("Noor Aziz (admission no. A-004)"));
    // Only enrolled students without an opt-in are offered.
    expect(dialog.queryByLabelText(/Sara Ali/)).toBeNull();
    const confirm = dialog.getByRole("button", { name: "Transfer seat" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(dialog.getByLabelText(/Note/), { target: { value: "Sibling takes it" } });
    await waitFor(() => expect(confirm.disabled).toBe(false));
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(bodiesOf("/api/school/license/student-ai/opt-ins/{optInId}/transfer")).toEqual([
        { toStudentId: students.noor, note: "Sibling takes it" },
      ]),
    );
    const call = postMock.mock.calls.find(
      ([path]) => path === "/api/school/license/student-ai/opt-ins/{optInId}/transfer",
    )!;
    expect(call[1]!.params!.path).toEqual({ optInId: "o-3" });
    expect(
      await screen.findByText("Lina Haddad's seat was transferred to Noor Aziz."),
    ).toBeTruthy();
  });

  test("filters the list to students who left with a seat", async () => {
    await renderPage();
    await (await table()).findByText("Sara Ali");
    const filters = within(screen.getByRole("group", { name: "Find students" }));
    fireEvent.click(filters.getByRole("combobox", { name: "Show" }));
    fireEvent.click(screen.getByRole("option", { name: "Left the school with a seat" }));
    await waitFor(() =>
      expect(
        getMock.mock.calls.some(
          ([path, init]) =>
            path === "/api/school/license/student-ai/students" &&
            init?.params?.query?.filter === "left_with_seat",
        ),
      ).toBe(true),
    );
  });

  test("without license:manage the page is read-only", async () => {
    await renderPage("FINANCE");
    const list = await table();
    await list.findByText("Lina Haddad");
    expect(list.queryAllByRole("checkbox")).toHaveLength(0);
    expect(list.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Close window" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Import CSV" })).toBeNull();
  });
});

describe("admissionNumbersFromCsv", () => {
  test("reads the column headed as admission numbers, without blanks or repeats", () => {
    expect(admissionNumbersFromCsv("Name,Admission No\nA,100\nB,\nC,101\nD,100\n")).toEqual([
      "100",
      "101",
    ]);
    expect(admissionNumbersFromCsv("الاسم,رقم القيد\nسارة,200\n")).toEqual(["200"]);
  });

  test("a single column is read whole; several unnamed columns are refused", () => {
    expect(admissionNumbersFromCsv("A-1\nA-2\n")).toEqual(["A-1", "A-2"]);
    expect(admissionNumbersFromCsv("Name,National ID\nSara,1234\n")).toBeNull();
  });
});

describe("firstOfNextMonth", () => {
  test("is the first of the following month, across a year end", () => {
    expect(firstOfNextMonth("2026-11-17")).toBe("2026-12-01");
    expect(firstOfNextMonth("2026-12-31")).toBe("2027-01-01");
  });
});
