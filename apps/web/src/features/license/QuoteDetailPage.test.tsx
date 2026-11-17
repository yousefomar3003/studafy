import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";

import { renderAs } from "./test-utils";

import type { ComponentType } from "react";

/**
 * A quote on the school's side: the full breakdown (list price, volume and duration discounts,
 * overlap credits, the adjustment, the total) and what the school saves; accepting a sent quote,
 * which opens the invoice it issues; declining it with an optional reason; and no Accept or Decline
 * on an expired quote or without license:manage.
 */

const QUOTE_ID = "11111111-1111-4111-8111-111111111111";
const INVOICE_ID = "22222222-2222-4222-8222-222222222222";
const DAY = 86_400_000;

function quote(overrides: Record<string, unknown> = {}) {
  return {
    id: QUOTE_ID,
    schoolId: "s-1",
    kind: "new",
    status: "sent",
    licenseId: null,
    currencyCode: "USD",
    minorUnit: 2,
    startsAt: "2026-11-01T00:00:00.000Z",
    endsAt: "2027-11-01T00:00:00.000Z",
    months: 12,
    prorateDays: null,
    includeFamilyPlus: false,
    notes: "Valid for this academic year",
    validUntil: new Date(Date.now() + 10 * DAY).toISOString(),
    createdAt: "2026-10-20T09:00:00.000Z",
    sentAt: "2026-10-20T10:00:00.000Z",
    totalMinor: 406_400,
    paymentPlan: "in_full",
    paymentSchedule: null,
    schedulePreview: [{ position: 1, amountMinor: 406_400, dueDate: "2026-12-01" }],
    yearTotals: [
      {
        year: 1,
        startDate: "2026-11-01",
        endDate: "2027-11-01",
        months: 12,
        amountMinor: 406_400,
        payments: 1,
      },
    ],
    changeRequestId: null,
    requestedTerms: null,
    termsChanges: [],
    termsChangeReason: null,
    breakdown: {
      currencyCode: "USD",
      months: 12,
      prorateDays: null,
      lines: [
        {
          kind: "seats",
          audience: "student",
          tierCode: "student_plus",
          tierName: "Student Plus",
          seats: 80,
          volumeSeats: 80,
          months: 12,
          prorateDays: null,
          listPricePerSeatMonthMinor: 500,
          listAmountMinor: 480_000,
          volumeDiscountBps: 500,
          volumeDiscountMinor: 24_000,
          durationDiscountBps: 1000,
          durationDiscountMinor: 45_600,
          amountMinor: 410_400,
          pricePerSeatMonthMinor: 428,
          savingsMinor: 69_600,
          nextVolumeBracket: null,
        },
        {
          kind: "overlap_credit",
          description: "Credit: Omar Saleh pays personally for 30 more days",
          creditMinor: 3000,
          amountMinor: -3000,
          reference: "o-1",
        },
        { kind: "adjustment", reason: "Loyal school", amountMinor: -1000 },
      ],
      listTotalMinor: 480_000,
      discountTotalMinor: 69_600,
      seatsSubtotalMinor: 410_400,
      creditTotalMinor: 3000,
      adjustmentMinor: -1000,
      totalMinor: 406_400,
      savingsMinor: 73_600,
      savingsBps: 1533,
    },
    ...overrides,
  };
}

let current = quote();

const getMock = mock((path: string) => {
  if (path === "/api/school/license/quotes/{quoteId}") return Promise.resolve({ data: current });
  if (path === "/api/school/license") {
    return Promise.resolve({ data: { license: null, usage: [], openChangeRequests: [] } });
  }
  if (path === "/api/school/license/invoices") {
    return Promise.resolve({ data: { invoices: [], status: "overdue" } });
  }
  throw new Error(`Unhandled GET ${path}`);
});
const postMock = mock((path: string, _init?: unknown) => {
  if (path === "/api/school/license/quotes/{quoteId}/accept") {
    return Promise.resolve({
      data: {
        quote: { ...current, status: "accepted" },
        invoice: { id: INVOICE_ID, number: "LIC-2026-000043" },
        renewalStops: [],
      },
    });
  }
  if (path === "/api/school/license/quotes/{quoteId}/decline") {
    const reason = (_init as { body: { reason: string | null } }).body.reason;
    current = quote({
      status: "declined",
      declineReason: reason,
      declinedAt: new Date().toISOString(),
    });
    return Promise.resolve({ data: current });
  }
  throw new Error(`Unhandled POST ${path}`);
});
mock.module("../../lib/api", () => ({ api: { GET: getMock, POST: postMock } }));

const loadPage = async (): Promise<ComponentType> => (await import("./QuoteDetailPage")).default;

async function renderPage(role = "PRINCIPAL") {
  const Page = await loadPage();
  return renderAs(role, <Page />, {
    path: "/portal/license/quotes/:quoteId",
    at: `/portal/license/quotes/${QUOTE_ID}`,
  });
}

afterEach(() => {
  cleanup();
  current = quote();
  getMock.mockClear();
  postMock.mockClear();
});

describe("QuoteDetailPage", () => {
  test("shows the full breakdown and what the school saves", async () => {
    await renderPage();
    const table = within(await screen.findByRole("table", { name: "Price breakdown" }));
    const amountOf = (label: string | RegExp) =>
      within(table.getByText(label).closest("tr")!).getByText(/\$/, { selector: "span" })
        .textContent;

    expect(amountOf(/^Student Plus: 80 Students/)).toBe("$4,800.00");
    expect(table.getByText(/\$5\.00 → \$4\.28 per seat per month/)).toBeTruthy();
    expect(amountOf("Volume discount (5%)")).toBe("-$240.00");
    expect(amountOf("Duration discount (10%)")).toBe("-$456.00");
    expect(amountOf("Credit: Omar Saleh pays personally for 30 more days")).toBe("-$30.00");
    expect(amountOf("Adjustment: Loyal school")).toBe("-$10.00");
    expect(screen.getAllByText("$4,064.00").length).toBeGreaterThan(0);
    expect(
      screen.getByText("You save $736.00 (15.33%) compared with the list price."),
    ).toBeTruthy();
    expect(screen.getByText("Valid for this academic year")).toBeTruthy();
  });

  test("a monthly quote shows its payment schedule before it is accepted", async () => {
    current = quote({
      paymentPlan: "monthly",
      schedulePreview: [
        { position: 1, amountMinor: 203_200, dueDate: "2026-11-01" },
        { position: 2, amountMinor: 203_200, dueDate: "2026-12-01" },
      ],
    });
    await renderPage();
    const section = within(await screen.findByRole("region", { name: "Payment schedule" }));
    expect(section.getByText("Paid monthly: 2 payments, one each licence month.")).toBeTruthy();
    expect(section.getAllByText("$2,032.00")).toHaveLength(2);
    expect(
      section.getByText(
        "Your seats start working once the first payment is received. The total is the same whichever way you pay.",
      ),
    ).toBeTruthy();
  });

  test("shows each licence year's total and every payment", async () => {
    current = quote({
      paymentPlan: "yearly",
      months: 13,
      endsAt: "2027-12-01T00:00:00.000Z",
      schedulePreview: [
        { position: 1, amountMinor: 375_138, dueDate: "2026-11-01" },
        { position: 2, amountMinor: 31_262, dueDate: "2027-11-01" },
      ],
      yearTotals: [
        {
          year: 1,
          startDate: "2026-11-01",
          endDate: "2027-11-01",
          months: 12,
          amountMinor: 375_138,
          payments: 1,
        },
        {
          year: 2,
          startDate: "2027-11-01",
          endDate: "2027-12-01",
          months: 1,
          amountMinor: 31_262,
          payments: 1,
        },
      ],
    });
    await renderPage();
    const section = within(await screen.findByRole("region", { name: "Payment schedule" }));
    expect(
      section.getByText("Paid yearly: 2 payments, one at the start of each licence year."),
    ).toBeTruthy();
    const years = within(section.getByTestId("year-totals"));
    expect(years.getByText("Year 1")).toBeTruthy();
    expect(years.getByText("Year 2")).toBeTruthy();
    expect(years.getByText(/Oct 31, 2027 \(12 months\)/)).toBeTruthy();
    expect(years.getByText(/Nov 30, 2027 \(1 month\)/)).toBeTruthy();
    expect(section.getAllByText("$3,751.38").length).toBeGreaterThanOrEqual(2);
    expect(section.getAllByText("$312.62").length).toBeGreaterThanOrEqual(2);
  });

  test("shows what the school asked for and why Studafy changed it", async () => {
    current = quote({
      paymentPlan: "yearly",
      months: 6,
      changeRequestId: "r-1",
      requestedTerms: {
        months: 12,
        startsOn: "2026-11-01",
        paymentPlan: "monthly",
        paymentProposal: null,
      },
      termsChanges: ["months", "plan"],
      termsChangeReason: "Six months is the most we can offer this term",
    });
    await renderPage();
    const terms = within(await screen.findByTestId("quote-terms"));
    expect(terms.getByText("12 months · from Nov 1, 2026 · paid monthly")).toBeTruthy();
    expect(terms.getByText("6 months · from Nov 1, 2026 · paid yearly")).toBeTruthy();
    expect(terms.getByTestId("quote-terms-changed").textContent).toBe(
      "Studafy changed what you chose: length, payment plan. Why: Six months is the most we can offer this term",
    );
  });

  test("a quote that follows the school's choice says so", async () => {
    current = quote({
      paymentPlan: "monthly",
      changeRequestId: "r-1",
      requestedTerms: { months: 12, startsOn: null, paymentPlan: "monthly", paymentProposal: null },
    });
    await renderPage();
    expect(
      await screen.findByText("This quote follows the length and payment plan you chose."),
    ).toBeTruthy();
  });

  test("accepts a sent quote and opens its invoice", async () => {
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Accept quote" }));
    const dialog = await screen.findByRole("dialog", { name: "Accept this quote?" });
    expect(dialog.textContent).toContain("Total: $4,064.00.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Accept and get the invoice" }));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    const [path, init] = postMock.mock.calls[0]!;
    expect(path).toBe("/api/school/license/quotes/{quoteId}/accept");
    expect((init as { params: { path: unknown } }).params.path).toEqual({ quoteId: QUOTE_ID });
    expect(await screen.findByText("Navigated away")).toBeTruthy();
    expect(
      await screen.findByText("Quote accepted. Invoice LIC-2026-000043 is ready."),
    ).toBeTruthy();
  });

  test("an expired or accepted quote cannot be accepted", async () => {
    current = quote({ validUntil: new Date(Date.now() - DAY).toISOString() });
    await renderPage();
    await screen.findByRole("table", { name: "Price breakdown" });
    expect(screen.queryByRole("button", { name: "Accept quote" })).toBeNull();
    cleanup();

    current = quote({ status: "accepted" });
    await renderPage();
    expect(await screen.findByText("Accepted")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept quote" })).toBeNull();
  });

  test("without license:manage the quote is shown but cannot be accepted", async () => {
    await renderPage("FINANCE");
    await screen.findByRole("table", { name: "Price breakdown" });
    expect(screen.queryByRole("button", { name: "Accept quote" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Decline quote" })).toBeNull();
  });

  test("declines a sent quote with a reason, after one confirmation", async () => {
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Decline quote" }));
    const dialog = await screen.findByRole("dialog", { name: "Decline this quote?" });
    fireEvent.change(within(dialog).getByLabelText("Why are you declining? (optional)"), {
      target: { value: "  Too expensive  " },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Decline quote" }));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    const [path, init] = postMock.mock.calls[0]!;
    expect(path).toBe("/api/school/license/quotes/{quoteId}/decline");
    expect(init).toMatchObject({
      params: { path: { quoteId: QUOTE_ID } },
      body: { reason: "Too expensive" },
    });
    expect(await screen.findByText("Quote declined. Studafy has been told.")).toBeTruthy();
  });

  test("declining without a reason sends none", async () => {
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Decline quote" }));
    const dialog = await screen.findByRole("dialog", { name: "Decline this quote?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Decline quote" }));
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postMock.mock.calls[0]![1]).toMatchObject({ body: { reason: null } });
  });

  test("a declined quote shows its reason and offers neither Accept nor Decline", async () => {
    current = quote({ status: "declined", declineReason: "We only need 10 seats" });
    await renderPage();
    expect(
      await screen.findByText("You declined this quote: “We only need 10 seats”"),
    ).toBeTruthy();
    expect(screen.getByText("Declined")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept quote" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Decline quote" })).toBeNull();
  });

  test("an expired quote cannot be declined", async () => {
    current = quote({ validUntil: new Date(Date.now() - DAY).toISOString() });
    await renderPage();
    await screen.findByRole("table", { name: "Price breakdown" });
    expect(screen.queryByRole("button", { name: "Decline quote" })).toBeNull();
  });
});
