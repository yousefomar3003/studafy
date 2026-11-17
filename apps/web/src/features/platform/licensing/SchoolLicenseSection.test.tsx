import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

/**
 * The license section of the console's school page: tier and seats per audience with what is used,
 * this month's usage, the actions the server's allowed transitions permit (suspend, cancel, resume,
 * activate, early activation with a due date), extending, changing seats through the calculator,
 * and assigning or unassigning seats on the school's behalf.
 */

const SCHOOL_ID = "11111111-1111-4111-8111-111111111111";
const LICENSE_ID = "22222222-2222-4222-8222-222222222222";
const INVOICE_ID = "33333333-3333-4333-8333-333333333333";
const SEAT_ID = "44444444-4444-4444-8444-444444444444";
const STUDENT_USER = "55555555-5555-4555-8555-555555555555";
const OTHER_USER = "66666666-6666-4666-8666-666666666666";

function license(status: "active" | "suspended" | "awaiting_payment") {
  return {
    id: LICENSE_ID,
    schoolId: SCHOOL_ID,
    status,
    currencyCode: "USD",
    includeFamilyPlus: true,
    startsAt: "2026-09-01T00:00:00.000Z",
    endsAt: "2027-08-31T00:00:00.000Z",
    activatedAt: status === "awaiting_payment" ? null : "2026-09-01T00:00:00.000Z",
    notes: null,
    createdAt: "2026-08-20T00:00:00.000Z",
    createdBy: "77777777-7777-4777-8777-777777777777",
    updatedAt: "2026-08-20T00:00:00.000Z",
    allowedTransitions: {
      active: ["suspended", "cancelled"],
      suspended: ["active", "cancelled"],
      awaiting_payment: ["active", "draft", "cancelled"],
    }[status],
    audiences: [
      {
        audience: "student",
        purchased: 80,
        assigned: 78,
        tier: { id: "t-1", code: "student_plus", displayName: "Student Plus" },
      },
      {
        audience: "teacher",
        purchased: 10,
        assigned: 2,
        tier: { id: "t-2", code: "teacher_basic", displayName: "Teacher Basic" },
      },
      { audience: "parent", purchased: 0, assigned: 0, tier: null },
    ],
    aiProgramme: {
      versionId: "88888888-8888-4888-8888-888888888888",
      versionNumber: 1,
      overrideId: null,
      overrideVersionNumber: null,
      appliedAt: "2026-08-20T00:00:00.000Z",
      nonpaymentGraceDays: 30,
      current: false,
    },
    commitment: "full_year",
  };
}

const PROGRAMME_VALUES = {
  currencyCode: "USD",
  iapPriceMinor: 600,
  licensePriceMinor: 400,
  parentPriceMinor: 600,
  minSeats: 30,
  maxShareBps: 1500,
  conversionTiers: [{ fromBps: 0, shareBps: 0 }],
  largeSchoolMinSeats: 500,
  largeSchoolShareBps: 800,
  contentBonusTiers: [{ fromBps: 0, shareBps: 0 }],
  bonusRequiresConversionShare: true,
  measurementOffsetDays: 30,
  nonpaymentGraceDays: 30,
  monthToMonthShareBps: 0,
  payoutMode: "invoice_credit",
  overridden: [],
};

let current = license("active");
let invoices: unknown[] = [];

const openInvoice = {
  id: INVOICE_ID,
  schoolId: SCHOOL_ID,
  schoolName: "Alpha Academy",
  licenseId: LICENSE_ID,
  quoteId: null,
  number: "LIC-2026-000007",
  paymentReference: "STF-AAAA-BBBB",
  status: "issued",
  currencyCode: "USD",
  minorUnit: 2,
  issueDate: "2026-10-01",
  dueDate: "2026-10-31",
  subtotalMinor: 480_000,
  creditTotalMinor: 0,
  adjustmentMinor: 0,
  totalMinor: 480_000,
  paidMinor: 0,
  balanceMinor: 480_000,
  overdue: false,
  overdueAt: null,
  voidedAt: null,
  voidReason: null,
  createdAt: "2026-10-01T00:00:00.000Z",
};

const getMock = mock((path: string, _init?: unknown) => {
  if (path === "/api/platform/schools/{schoolId}/license-console") {
    return Promise.resolve({
      data: {
        license: current,
        usage: [
          { feature: "ai_tutor", unit: "messages", used: 1200 },
          { feature: "auto_grading", unit: "submissions", used: 35 },
        ],
        payments: [],
        history: [
          {
            id: "h-1",
            targetTable: "school_licenses",
            targetId: LICENSE_ID,
            action: "update",
            actorId: null,
            oldValues: { status: "awaiting_payment" },
            newValues: { status: "active" },
            createdAt: "2026-09-01T00:00:00.000Z",
          },
        ],
      },
    });
  }
  if (path === "/api/platform/licenses/invoices") {
    return Promise.resolve({ data: { invoices, status: "all" } });
  }
  if (path === "/api/platform/schools/{schoolId}/license-quotes") {
    return Promise.resolve({ data: { quotes: [] } });
  }
  if (path === "/api/platform/schools/{schoolId}/licenses/{licenseId}/seats") {
    return Promise.resolve({
      data: {
        seats: [
          {
            seatId: SEAT_ID,
            userId: STUDENT_USER,
            studentId: "s-1",
            audience: "student",
            name: "Sara Ali",
            email: "sara@alpha.test",
            assignedAt: "2026-09-02T00:00:00.000Z",
            assignedByPlatform: false,
            unassignedAt: null,
            programme: false,
            overlap: null,
          },
          {
            seatId: "99999999-9999-4999-8999-999999999999",
            userId: OTHER_USER,
            studentId: "s-2",
            audience: "student",
            name: "Lina Haddad",
            email: "lina@alpha.test",
            assignedAt: "2026-09-03T00:00:00.000Z",
            assignedByPlatform: false,
            unassignedAt: null,
            programme: true,
            overlap: null,
          },
        ],
        total: 2,
      },
    });
  }
  if (path === "/api/platform/schools/{schoolId}/members") {
    return Promise.resolve({
      data: {
        members: [{ userId: OTHER_USER, displayName: "Omar Saleh", email: "omar@alpha.test" }],
        total: 1,
        memberCount: 1,
        roleCounts: { STUDENT: 1 },
      },
    });
  }
  if (path === "/api/platform/schools/{schoolId}/licenses/{licenseId}/ai-programme") {
    return Promise.resolve({
      data: {
        licenseId: LICENSE_ID,
        stamp: current.aiProgramme,
        signed: PROGRAMME_VALUES,
        current: { ...PROGRAMME_VALUES, nonpaymentGraceDays: 45 },
        currentVersionNumber: 2,
        currentOverrideVersionNumber: null,
        changes: ["nonpaymentGraceDays"],
      },
    });
  }
  throw new Error(`Unhandled GET ${path}`);
});
const postMock = mock((path: string, _init?: { body?: Record<string, unknown> }) => {
  if (path === "/api/platform/schools/{schoolId}/licenses/{licenseId}/status") {
    return Promise.resolve({ data: current });
  }
  if (path === "/api/platform/schools/{schoolId}/licenses/{licenseId}/extend") {
    return Promise.resolve({ data: current });
  }
  if (path === "/api/platform/schools/{schoolId}/license-invoices/{invoiceId}/activate-early") {
    return Promise.resolve({ data: { invoice: openInvoice, licenseActivated: true } });
  }
  if (path === "/api/platform/schools/{schoolId}/licenses/{licenseId}/seats") {
    return Promise.resolve({ data: { assigned: [{}], notAssigned: [], renewalStops: [] } });
  }
  if (path === "/api/platform/schools/{schoolId}/licenses/{licenseId}/ai-programme/reapply") {
    return Promise.resolve({ data: {} });
  }
  throw new Error(`Unhandled POST ${path}`);
});
const deleteMock = mock((_path: string, _init?: unknown) =>
  Promise.resolve({ data: { seatId: SEAT_ID } }),
);

mock.module("../../../lib/api", () => ({
  api: { GET: getMock, POST: postMock, DELETE: deleteMock },
}));

async function renderSection() {
  const { SchoolLicenseSection } = await import("./SchoolLicenseSection");
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter>
          <SchoolLicenseSection schoolId={SCHOOL_ID} schoolName="Alpha Academy" />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function bodiesOf(path: string) {
  return postMock.mock.calls.filter(([called]) => called === path).map(([, init]) => init!.body!);
}

async function actions() {
  return within(await screen.findByRole("group", { name: "License actions" }));
}

afterEach(() => {
  cleanup();
  current = license("active");
  invoices = [];
  getMock.mockClear();
  postMock.mockClear();
  deleteMock.mockClear();
});

describe("SchoolLicenseSection", () => {
  test("shows the Student AI programme version the licence was signed with and re-applies the current one with a reason", async () => {
    await renderSection();
    expect((await screen.findByTestId("programme-version")).textContent).toBe("Version 1");
    expect(screen.getByTestId("programme-current").textContent).toBe("Newer settings available");
    expect(screen.getByText("Edit this school's settings").getAttribute("href")).toBe(
      `/portal/platform/ai-programme?schoolId=${SCHOOL_ID}`,
    );
    fireEvent.click(screen.getByRole("button", { name: "Apply current settings" }));
    const dialog = await screen.findByRole("dialog");
    const changes = await within(dialog).findByTestId("apply-changes");
    expect(within(changes).getByText("30 days")).toBeTruthy();
    expect(within(changes).getByText("45 days")).toBeTruthy();
    const confirm = within(dialog).getByRole("button", { name: "Apply settings" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Reason for this change"), {
      target: { value: "Renewal terms agreed" },
    });
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(
        bodiesOf("/api/platform/schools/{schoolId}/licenses/{licenseId}/ai-programme/reapply"),
      ).toEqual([{ reason: "Renewal terms agreed" }]),
    );
  });

  test("a licence on the current settings offers no re-apply", async () => {
    current = {
      ...license("active"),
      aiProgramme: { ...license("active").aiProgramme, current: true },
    };
    await renderSection();
    expect((await screen.findByTestId("programme-current")).textContent).toBe("Current settings");
    expect(screen.queryByRole("button", { name: "Apply current settings" })).toBeNull();
  });

  test("shows tiers, seats used of purchased, Family+ and this month's usage", async () => {
    await renderSection();
    const seats = await screen.findByRole("table", { name: "Tier and seats per audience" });
    const students = within(seats).getByText("Student Plus").closest("tr")!;
    expect(within(students).getByText("78 used of 80")).toBeTruthy();
    const teachers = within(seats).getByText("Teacher Basic").closest("tr")!;
    expect(within(teachers).getByText("2 used of 10")).toBeTruthy();

    const usage = screen.getByRole("list", { name: "Usage this month" });
    expect(within(usage).getByText("1,200 messages")).toBeTruthy();
    expect(within(usage).getByText("35 submissions")).toBeTruthy();
    expect(screen.getByText("Nothing owed")).toBeTruthy();
    expect(screen.getByTestId("license-commitment").textContent).toBe("Full year committed");

    const history = screen.getByRole("list", { name: "History" });
    expect(within(history).getByText(/→ active/)).toBeTruthy();
  });

  test("an active license offers suspend, cancel, extend and a seat change -- not activate", async () => {
    await renderSection();
    const group = await actions();
    expect(group.getByRole("button", { name: "Suspend" })).toBeTruthy();
    expect(group.getByRole("button", { name: "Cancel license" })).toBeTruthy();
    expect(group.getByRole("button", { name: "Extend" })).toBeTruthy();
    expect(group.queryByRole("button", { name: "Activate" })).toBeNull();
    expect(group.queryByRole("button", { name: "Resume" })).toBeNull();

    const change = group.getByRole("link", { name: "Change seats or tiers" });
    expect(change.getAttribute("href")).toBe(
      `/portal/platform/quotes?schoolId=${SCHOOL_ID}&licenseId=${LICENSE_ID}&kind=seat_increase`,
    );
  });

  test("suspending asks for confirmation, then posts the status", async () => {
    await renderSection();
    fireEvent.click((await actions()).getByRole("button", { name: "Suspend" }));
    const dialog = await screen.findByRole("dialog", { name: "Suspend this license?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));

    await waitFor(() =>
      expect(bodiesOf("/api/platform/schools/{schoolId}/licenses/{licenseId}/status")).toEqual([
        { status: "suspended" },
      ]),
    );
    expect(await screen.findByText("License suspended.")).toBeTruthy();
  });

  test("a suspended license can be resumed", async () => {
    current = license("suspended");
    await renderSection();
    fireEvent.click((await actions()).getByRole("button", { name: "Resume" }));
    const dialog = await screen.findByRole("dialog", { name: "Resume this license?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));

    await waitFor(() =>
      expect(bodiesOf("/api/platform/schools/{schoolId}/licenses/{licenseId}/status")).toEqual([
        { status: "active" },
      ]),
    );
  });

  test("extending needs an end date later than the current one", async () => {
    await renderSection();
    fireEvent.click((await actions()).getByRole("button", { name: "Extend" }));
    const dialog = await screen.findByRole("dialog", { name: "Extend the license" });
    const confirm = within(dialog).getByRole("button", { name: "Extend" }) as HTMLButtonElement;
    const date = within(dialog).getByLabelText("New end date");

    fireEvent.change(date, { target: { value: "2027-06-30" } });
    expect(within(dialog).getByText("Later than the current end date.")).toBeTruthy();
    expect(confirm.disabled).toBe(true);

    fireEvent.change(date, { target: { value: "2028-08-31" } });
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(bodiesOf("/api/platform/schools/{schoolId}/licenses/{licenseId}/extend")).toEqual([
        { endsAt: "2028-08-31T00:00:00.000Z" },
      ]),
    );
  });

  test("a license awaiting payment can be activated, or activated early with a due date", async () => {
    current = license("awaiting_payment");
    invoices = [openInvoice];
    await renderSection();
    const group = await actions();
    expect(group.getByRole("button", { name: "Activate" })).toBeTruthy();
    expect(await screen.findByText("$4,800.00", { selector: "dd" })).toBeTruthy();
    // A license not yet in force is re-priced as a new term, in place.
    expect(group.getByRole("link", { name: "Change seats or tiers" }).getAttribute("href")).toBe(
      `/portal/platform/quotes?schoolId=${SCHOOL_ID}&licenseId=${LICENSE_ID}&kind=new`,
    );

    fireEvent.click(await group.findByRole("button", { name: "Activate early with a due date" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Activate early: LIC-2026-000007",
    });
    const due = within(dialog).getByLabelText("Payment due by") as HTMLInputElement;
    expect(due.value).toBe("2026-10-31");
    fireEvent.change(due, { target: { value: "2026-12-15" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Activate" }));

    await waitFor(() =>
      expect(
        bodiesOf("/api/platform/schools/{schoolId}/license-invoices/{invoiceId}/activate-early"),
      ).toEqual([{ dueDate: "2026-12-15" }]),
    );
    expect(await screen.findByText("License activated.")).toBeTruthy();
  });

  test("unassigns a seat on the school's behalf", async () => {
    await renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Unassign Sara Ali" }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledTimes(1));
    expect(deleteMock.mock.calls[0]![0]).toBe(
      "/api/platform/schools/{schoolId}/licenses/{licenseId}/seats/{seatId}",
    );
    expect((deleteMock.mock.calls[0]![1] as { params: { path: unknown } }).params.path).toEqual({
      schoolId: SCHOOL_ID,
      licenseId: LICENSE_ID,
      seatId: SEAT_ID,
    });
    expect(await screen.findByText("Seat unassigned.")).toBeTruthy();
  });

  test("a Student AI seat held for the year is marked and can't be unassigned", async () => {
    await renderSection();
    const button = await screen.findByRole("button", { name: "Unassign Lina Haddad" });
    const row = button.closest("tr")!;
    expect(within(row).getByTestId("programme-seat").textContent).toBe("Student AI (whole year)");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Unassign Sara Ali" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  test("assigns seats to people picked from the school", async () => {
    await renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Assign seats" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Assign seats on the school's behalf",
    });
    fireEvent.click(await within(dialog).findByLabelText("Omar Saleh · omar@alpha.test"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Assign 1 person" }));

    await waitFor(() =>
      expect(bodiesOf("/api/platform/schools/{schoolId}/licenses/{licenseId}/seats")).toEqual([
        { audience: "student", userIds: [OTHER_USER] },
      ]),
    );
    expect(await screen.findByText("1 seat assigned (0 not).")).toBeTruthy();
  });
});
