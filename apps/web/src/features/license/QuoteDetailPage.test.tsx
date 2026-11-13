import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";

import { renderAs } from "./test-utils";

import type { ComponentType } from "react";

/**
 * A quote on the school's side: the full breakdown (list price, volume and duration discounts,
 * overlap credits, the adjustment, the total) and what the school saves; accepting a sent quote,
 * which opens the invoice it issues; and no Accept on an expired quote or without license:manage.
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
    expect(screen.getByText("$4,064.00")).toBeTruthy();
    expect(
      screen.getByText("You save $736.00 (15.33%) compared with the list price."),
    ).toBeTruthy();
    expect(screen.getByText("Valid for this academic year")).toBeTruthy();
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
  });
});
