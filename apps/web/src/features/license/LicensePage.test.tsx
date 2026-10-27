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

function overview() {
  return {
    license: {
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
    expect(facts("Family+")).toBe("Not included");
    await waitFor(() => expect(facts("Balance due")).toBe("$600.00"));

    const table = within(
      await screen.findByRole("table", { name: "Seats and what each group gets" }),
    );
    const students = table.getByText("Students").closest("tr")!;
    expect(within(students).getByText("Student Plus")).toBeTruthy();
    expect(within(students).getByText("46 used of 50")).toBeTruthy();
    const gets = within(await within(students).findByRole("list", { name: "What Students get" }));
    expect(gets.getByText("AI tutor: 300 messages a month")).toBeTruthy();
    expect(gets.getByText("Study tools: Unlimited")).toBeTruthy();
    // No Family+: no parents row.
    expect(table.queryByText("Parents (Family+)")).toBeNull();

    const usage = within(screen.getByRole("table", { name: "Usage this month" }));
    expect(
      within(usage.getByText("AI tutor").closest("tr")!).getByText("1,200 messages"),
    ).toBeTruthy();
    expect(usage.getByText("35 generations")).toBeTruthy();
    expect(usage.queryByText("family_plus")).toBeNull();

    const requests = within(screen.getByRole("region", { name: "Requests waiting for Studafy" }));
    expect(requests.getByText(/60 student seats · Student Pro for Students/)).toBeTruthy();
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

  test("requests more seats and a different tier", async () => {
    await renderPage();
    fireEvent.click(
      await screen.findByRole("button", { name: "Request more seats or a different tier" }),
    );
    const dialog = within(
      await screen.findByRole("dialog", { name: "Request more seats or a different tier" }),
    );
    const send = dialog.getByRole("button", { name: "Send request" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);

    fireEvent.change(dialog.getByLabelText("Students: seats wanted in total"), {
      target: { value: "80" },
    });
    fireEvent.click(dialog.getByRole("combobox", { name: "Students: tier" }));
    fireEvent.click(await screen.findByRole("option", { name: "Student Pro" }));
    // A note is required.
    expect(send.disabled).toBe(true);
    fireEvent.change(dialog.getByLabelText(/Note for Studafy/), {
      target: { value: "Two new classes" },
    });
    expect(send.disabled).toBe(false);
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
    });
    expect(await screen.findByText("Request sent to Studafy.")).toBeTruthy();
  });

  test("the almost-full banner's link opens the request form", async () => {
    await renderPage("PRINCIPAL", "/portal/license?request=1");
    expect(
      await screen.findByRole("dialog", { name: "Request more seats or a different tier" }),
    ).toBeTruthy();
  });

  test("without license:manage there is no request form", async () => {
    await renderPage("FINANCE", "/portal/license?request=1");
    await screen.findByText("Active");
    expect(
      screen.queryByRole("button", { name: "Request more seats or a different tier" }),
    ).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
