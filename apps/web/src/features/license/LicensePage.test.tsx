import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";

import { renderAs } from "./test-utils";

import type { ComponentType } from "react";

/**
 * The school's license overview: tier and seats per audience, Family+, dates, status and balance due;
 * what each audience gets in its tier; this month's usage; the banners (ending soon, an invoice
 * overdue, seats almost full); and the change request form, which only license:manage sees.
 */

const DAY = 86_400_000;
const PLUS = "11111111-1111-4111-8111-111111111111";
const PRO = "22222222-2222-4222-8222-222222222222";

let endsInDays = 200;
let overdue: unknown[] = [];
let hasLicense = true;
let licenseExtra: Record<string, unknown> = {};
let requestSource = "school";

function overview() {
  return {
    license: !hasLicense
      ? null
      : {
          id: "licence-1",
          status: "active",
          startsAt: "2026-09-01T00:00:00.000Z",
          endsAt: new Date(Date.now() + endsInDays * DAY - 3_600_000).toISOString(),
          includeFamilyPlus: false,
          currencyCode: "USD",
          activatedAt: "2026-09-01T00:00:00.000Z",
          audiences: [
            {
              audience: "student",
              purchased: 50,
              assigned: 46,
              tier: { id: PLUS, code: "student_plus", displayName: "Student Plus" },
            },
            { audience: "teacher", purchased: 10, assigned: 2, tier: null },
            { audience: "parent", purchased: 0, assigned: 0, tier: null },
          ],
          nonpaymentSuspendedAt: null,
          nextAiStop: null,
          commitment: "full_year",
          ...licenseExtra,
        },
    usage: [
      { feature: "ai_tutor", unit: "messages", used: 1200 },
      { feature: "study_tools", unit: "generations", used: 35 },
      { feature: "family_plus", unit: null, used: 0 },
    ],
    openChangeRequests: [
      {
        id: "r-1",
        licenseId: "licence-1",
        studentSeats: 60,
        teacherSeats: null,
        parentSeats: null,
        includeFamilyPlus: null,
        studentTier: { id: PRO, code: "student_pro", displayName: "Student Pro" },
        teacherTier: null,
        parentTier: null,
        note: "Grade 9 joins in January",
        status: "open",
        requestedBy: "u-1",
        createdAt: "2026-10-20T09:00:00.000Z",
        resolvedAt: null,
        resolutionNote: null,
        months: 12,
        startsOn: null,
        paymentPlan: "yearly",
        paymentProposal: null,
        source: requestSource,
      },
    ],
  };
}

const tiers = [
  {
    id: PLUS,
    code: "student_plus",
    displayName: "Student Plus",
    description: null,
    audience: "student",
    rank: 1,
    isActive: true,
    includesAllFeatures: false,
    features: [
      { key: "ai_tutor", name: "AI tutor", unit: "messages", monthlyLimit: 300, status: "active" },
      {
        key: "study_tools",
        name: "Study tools",
        unit: "generations",
        monthlyLimit: null,
        status: "active",
      },
    ],
  },
  {
    id: PRO,
    code: "student_pro",
    displayName: "Student Pro",
    description: null,
    audience: "student",
    rank: 2,
    isActive: true,
    includesAllFeatures: true,
    features: [],
  },
];

const unpaid = [
  {
    id: "i-1",
    number: "LIC-2026-000042",
    currencyCode: "USD",
    minorUnit: 2,
    balanceMinor: 60_000,
    status: "partially_paid",
    overdue: true,
  },
];

const getMock = mock((path: string, init?: { params?: { query?: { status?: string } } }) => {
  switch (path) {
    case "/api/school/license":
      return Promise.resolve({ data: overview() });
    case "/api/school/license/tiers":
      return Promise.resolve({ data: { tiers } });
    case "/api/school/license/invoices": {
      const status = init?.params?.query?.status;
      return Promise.resolve({
        data: { invoices: status === "overdue" ? overdue : unpaid, status },
      });
    }
    default:
      throw new Error(`Unhandled GET ${path}`);
  }
});
const postMock = mock((path: string, init?: { body?: Record<string, unknown> }) => {
  if (path === "/api/school/license/change-requests") {
    return Promise.resolve({ data: { ...overview().openChangeRequests[0], ...init!.body } });
  }
  throw new Error(`Unhandled POST ${path}`);
});
mock.module("../../lib/api", () => ({ api: { GET: getMock, POST: postMock } }));

const loadPage = async (): Promise<ComponentType> => (await import("./LicensePage")).default;

async function renderPage(role = "PRINCIPAL", at = "/portal/license") {
  const Page = await loadPage();
  return renderAs(role, <Page />, { path: "/portal/license", at });
}

afterEach(() => {
  cleanup();
  hasLicense = true;
  licenseExtra = {};
  requestSource = "school";
  endsInDays = 200;
  overdue = [];
  getMock.mockClear();
  postMock.mockClear();
});

describe("LicensePage", () => {
  test("shows the license: status, dates, Family+, balance, seats and what each group gets", async () => {
    await renderPage();
    const facts = (label: string) =>
      screen.getByText(label, { selector: "dt" }).parentElement!.querySelector("dd")!.textContent;
    await screen.findByText("Active");
    // Family+ is not built yet: no Family+ fact on a license without it.
    expect(screen.queryByText("Family+", { selector: "dt" })).toBeNull();
    await waitFor(() => expect(facts("Balance due")).toBe("$600.00"));
    expect(facts("Commitment")).toBe("Full year committed");

    const table = within(
      await screen.findByRole("table", { name: "Seats and what each group gets" }),
    );
    const students = table.getByText("Students").closest("tr")!;
    expect(within(students).getByText("Student Plus")).toBeTruthy();
    expect(within(students).getByText("46 used of 50")).toBeTruthy();
    const gets = within(await within(students).findByRole("list", { name: "What Students get" }));
    expect(gets.getByText("AI tutor: 300 messages a month")).toBeTruthy();
    expect(gets.getByText("Study tools: Unlimited")).toBeTruthy();
    // No Family+: no parents row. Teacher seats are no longer sold, but this license already holds
    // ten, so they still show.
    expect(table.queryByText("Parents (Family+)")).toBeNull();
    expect(table.getByText("Teachers")).toBeTruthy();

    const usage = within(screen.getByRole("table", { name: "Usage this month" }));
    expect(
      within(usage.getByText("AI tutor").closest("tr")!).getByText("1,200 messages"),
    ).toBeTruthy();
    expect(usage.getByText("35 generations")).toBeTruthy();
    expect(usage.queryByText("family_plus")).toBeNull();

    const requests = within(screen.getByRole("region", { name: "Requests waiting for Studafy" }));
    expect(
      requests.getByText(/60 student seats · Student Pro for Students · 12 months · paid yearly/),
    ).toBeTruthy();
    expect(requests.queryByTestId("request-automatic")).toBeNull();
  });

  test("a seat request Student AI opt-ins opened on their own is marked automatic", async () => {
    requestSource = "ai_optin";
    licenseExtra = { commitment: "month_to_month" };
    await renderPage();
    const requests = within(
      await screen.findByRole("region", { name: "Requests waiting for Studafy" }),
    );
    expect(requests.getByTestId("request-automatic").textContent).toBe(
      "Automatic · Student AI opt-ins",
    );
    expect(
      screen.getByText("Commitment", { selector: "dt" }).parentElement!.querySelector("dd")!
        .textContent,
    ).toBe("Month to month");
  });

  test("warns when seats are almost full, the license ends soon and an invoice is overdue", async () => {
    endsInDays = 12;
    overdue = unpaid;
    await renderPage();
    expect(await screen.findByText("Your license ends in 12 days")).toBeTruthy();
    const late = await screen.findByRole("alert");
    expect(within(late).getByText("An invoice is overdue")).toBeTruthy();
    expect(late.textContent).toContain("$600.00 is still due on LIC-2026-000042.");
    expect(within(late).getByRole("link", { name: "See how to pay" }).getAttribute("href")).toBe(
      "/portal/license/invoices/i-1",
    );
    expect(screen.getByText("Student seats are almost full")).toBeTruthy();
    expect(screen.getByText(/46 of 50 seats are in use\./)).toBeTruthy();
    // Teachers use 2 of 10: no banner for them.
    expect(screen.queryByText("Teacher seats are almost full")).toBeNull();
  });

  test("no ending-soon or overdue banner when neither applies", async () => {
    await renderPage();
    await screen.findByText("Active");
    expect(screen.queryByText(/Your license ends/)).toBeNull();
    expect(screen.queryByText(/overdue/)).toBeNull();
  });

  test("requests AI for more students on a different tier", async () => {
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Request AI for students" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Request AI for students" }));
    const send = dialog.getByRole("button", { name: "Send request" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    // Only students: no teacher or parent seats, no Family+.
    expect(dialog.queryByText(/Teachers/)).toBeNull();
    expect(dialog.queryByText(/Family\+/)).toBeNull();

    fireEvent.change(dialog.getByLabelText("Number of students"), {
      target: { value: "80" },
    });
    fireEvent.click(dialog.getByRole("combobox", { name: "AI tier" }));
    fireEvent.click(await screen.findByRole("option", { name: "Student Pro" }));
    // The note is optional.
    expect(send.disabled).toBe(false);
    fireEvent.change(dialog.getByLabelText(/Note for Studafy/), {
      target: { value: "Two new classes" },
    });
    fireEvent.click(send);

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postMock.mock.calls[0]![1]!.body).toEqual({
      studentSeats: 80,
      teacherSeats: null,
      parentSeats: null,
      studentPlanId: PRO,
      teacherPlanId: null,
      parentPlanId: null,
      includeFamilyPlus: null,
      note: "Two new classes",
      // A licence in force: the new seats run to its end, paid monthly unless the school chooses.
      months: null,
      startsOn: null,
      paymentPlan: "monthly",
      paymentProposal: null,
    });
    expect(await screen.findByText("Request sent to Studafy.")).toBeTruthy();
  });

  test("a school with no license requests AI for its students", async () => {
    hasLicense = false;
    await renderPage();
    expect(await screen.findByText(/Your school has no license yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Request AI for students" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Request AI for students" }));
    const send = dialog.getByRole("button", { name: "Send request" }) as HTMLButtonElement;
    // A first license needs a number of students; a tier alone is not enough.
    fireEvent.click(dialog.getByRole("combobox", { name: "AI tier" }));
    fireEvent.click(await screen.findByRole("option", { name: "Student Plus" }));
    expect(send.disabled).toBe(true);
    fireEvent.change(dialog.getByLabelText(/Number of students/), { target: { value: "300" } });
    expect(send.disabled).toBe(false);
    fireEvent.click(send);

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postMock.mock.calls[0]![1]!.body).toMatchObject({
      studentSeats: 300,
      studentPlanId: PLUS,
      // No note given: the request says what it is for the inbox.
      note: "Student AI for 300 students, Student Plus.",
    });
  });

  test("a new licence: the school chooses 13 months, paid yearly, and sees each year", async () => {
    hasLicense = false;
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Request AI for students" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Request AI for students" }));
    fireEvent.change(dialog.getByLabelText(/Number of students/), { target: { value: "100" } });
    fireEvent.click(dialog.getByRole("combobox", { name: "How long do you want Studafy AI for?" }));
    fireEvent.click(await screen.findByRole("option", { name: "Another number of months" }));
    fireEvent.change(dialog.getByLabelText("Months (1–36)"), { target: { value: "13" } });
    fireEvent.change(dialog.getByLabelText("Start on (optional)"), {
      target: { value: "2099-09-01" },
    });
    fireEvent.click(dialog.getByRole("radio", { name: "Yearly" }));

    const years = within(dialog.getByTestId("year-totals"));
    expect(years.getByText("Year 1")).toBeTruthy();
    expect(years.getByText("Year 2")).toBeTruthy();
    expect(years.getByText(/Aug 31, 2100 \(12 months\)/)).toBeTruthy();
    expect(years.getByText(/Sep 30, 2100 \(1 month\)/)).toBeTruthy();
    const payments = within(dialog.getByTestId("terms-payments"));
    expect(payments.getAllByRole("row")).toHaveLength(3);
    expect(payments.getByText("Sep 1, 2099")).toBeTruthy();
    expect(payments.getByText("Sep 1, 2100")).toBeTruthy();
    expect(payments.getByText("92.31%")).toBeTruthy();
    expect(payments.getByText("7.69%")).toBeTruthy();

    fireEvent.click(dialog.getByRole("button", { name: "Send request" }));
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postMock.mock.calls[0]![1]!.body).toMatchObject({
      studentSeats: 100,
      months: 13,
      startsOn: "2099-09-01",
      paymentPlan: "yearly",
      paymentProposal: null,
    });
  });

  test("a custom plan: the school's own dates and shares, which must add up to 100%", async () => {
    hasLicense = false;
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Request AI for students" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Request AI for students" }));
    fireEvent.change(dialog.getByLabelText(/Number of students/), { target: { value: "40" } });
    fireEvent.change(dialog.getByLabelText("Start on (optional)"), {
      target: { value: "2099-01-01" },
    });
    fireEvent.click(dialog.getByRole("radio", { name: "Custom: our own dates" }));
    // 12 months by default; two even payments to start from.
    expect((dialog.getByLabelText("Payment 1: date") as HTMLInputElement).value).toBe("2099-01-01");
    expect((dialog.getByLabelText("Payment 2: date") as HTMLInputElement).value).toBe("2099-07-01");
    expect(
      (dialog.getByLabelText("Payment 1: share of the total (%)") as HTMLInputElement).value,
    ).toBe("50");
    const send = dialog.getByRole("button", { name: "Send request" }) as HTMLButtonElement;
    expect(send.disabled).toBe(false);

    fireEvent.change(dialog.getByLabelText("Payment 1: share of the total (%)"), {
      target: { value: "30" },
    });
    expect(dialog.getByText("The shares must add up to exactly 100%.")).toBeTruthy();
    expect(send.disabled).toBe(true);
    fireEvent.change(dialog.getByLabelText("Payment 2: share of the total (%)"), {
      target: { value: "70" },
    });
    // A date after the licence ends is refused.
    fireEvent.change(dialog.getByLabelText("Payment 2: date"), { target: { value: "2100-02-01" } });
    expect(dialog.getByText("Every payment must fall before the licence ends.")).toBeTruthy();
    fireEvent.change(dialog.getByLabelText("Payment 2: date"), { target: { value: "2099-06-15" } });
    expect(send.disabled).toBe(false);

    fireEvent.click(send);
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postMock.mock.calls[0]![1]!.body).toMatchObject({
      months: 12,
      paymentPlan: "custom",
      paymentProposal: [
        { dueDate: "2099-01-01", shareBps: 3000 },
        { dueDate: "2099-06-15", shareBps: 7000 },
      ],
    });
  });

  test("warns before the AI stops for an unpaid instalment", async () => {
    licenseExtra = {
      nextAiStop: {
        invoiceId: "i-1",
        invoiceNumber: "LIC-2026-000042",
        position: 2,
        dueDate: "2026-11-01",
        stopDate: "2026-12-01",
        balanceMinor: 60_000,
        currencyCode: "USD",
        minorUnit: 2,
        daysLeft: 5,
      },
    };
    await renderPage();
    expect(
      await screen.findByText("Studafy AI stops on December 1, 2026 if this payment is not made"),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /\$600.00 on invoice LIC-2026-000042 was due November 1, 2026\. 5 days left/,
      ),
    ).toBeTruthy();
  });

  test("says when the AI has stopped for non-payment", async () => {
    licenseExtra = {
      status: "suspended",
      nonpaymentSuspendedAt: "2026-12-01T00:05:00.000Z",
      nextAiStop: {
        invoiceId: "i-1",
        invoiceNumber: "LIC-2026-000042",
        position: 2,
        dueDate: "2026-11-01",
        stopDate: "2026-12-01",
        balanceMinor: 60_000,
        currencyCode: "USD",
        minorUnit: 2,
        daysLeft: -3,
      },
    };
    await renderPage();
    expect(await screen.findByText("Studafy AI has stopped")).toBeTruthy();
    expect(screen.queryByText(/if this payment is not made/)).toBeNull();
  });

  test("the almost-full banner's link opens the request form", async () => {
    await renderPage("PRINCIPAL", "/portal/license?request=1");
    expect(await screen.findByRole("dialog", { name: "Request AI for students" })).toBeTruthy();
  });

  test("without license:manage there is no request form", async () => {
    await renderPage("FINANCE", "/portal/license?request=1");
    await screen.findByText("Active");
    expect(screen.queryByRole("button", { name: "Request AI for students" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
