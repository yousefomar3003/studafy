import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import type { ComponentType } from "react";

/**
 * The license calculator: the terms the super admin picks go to the pricing route as they settle,
 * the breakdown shows every figure the API priced (list, both discounts, credits, the adjustment,
 * the total, the price per seat and the saving), the next volume bracket is offered as "add N
 * seats", an adjustment cannot be saved without a reason, a saved quote can be sent, and a draft
 * license is re-priced in place rather than duplicated.
 */

const SCHOOL_ID = "11111111-1111-4111-8111-111111111111";
const STUDENT_TIER = "22222222-2222-4222-8222-222222222222";
const TEACHER_TIER = "33333333-3333-4333-8333-333333333333";
const LICENSE_ID = "44444444-4444-4444-8444-444444444444";
const QUOTE_ID = "55555555-5555-4555-8555-555555555555";

const tiers = [
  {
    id: STUDENT_TIER,
    code: "student_plus",
    displayName: "Student Plus",
    description: null,
    audience: "student",
    rank: 2,
    includesAllFeatures: false,
    isActive: true,
    inUse: 0,
    features: [{ key: "ai_tutor", monthlyLimit: 300 }],
    prices: [{ currencyCode: "USD", amountMinor: 500, minorUnit: 2, isActive: true }],
  },
  {
    id: TEACHER_TIER,
    code: "teacher_basic",
    displayName: "Teacher Basic",
    description: null,
    audience: "teacher",
    rank: 1,
    includesAllFeatures: false,
    isActive: true,
    inUse: 0,
    features: [{ key: "auto_grading", monthlyLimit: 500 }],
    prices: [{ currencyCode: "USD", amountMinor: 800, minorUnit: 2, isActive: true }],
  },
];

let licenses: unknown[] = [];

const quote = {
  id: QUOTE_ID,
  schoolId: SCHOOL_ID,
  kind: "new",
  status: "draft",
  licenseId: null,
  currencyCode: "USD",
  minorUnit: 2,
  totalMinor: 406_400,
  createdAt: "2026-10-20T09:00:00.000Z",
  validUntil: "2026-11-19T09:00:00.000Z",
  invoiceId: null,
};

/** 80 student seats for 12 months at 5.00: 5% volume, then 10% for the term, a credit and -10.00. */
const calculation = {
  kind: "new",
  licenseId: null,
  currencyCode: "USD",
  startsAt: "2026-11-01T00:00:00.000Z",
  endsAt: "2027-11-01T00:00:00.000Z",
  months: 12,
  prorateDays: null,
  includeFamilyPlus: false,
  audiences: [],
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
        nextVolumeBracket: {
          minSeats: 100,
          discountBps: 1000,
          seatsToAdd: 20,
          pricePerSeatMonthMinor: 405,
        },
      },
      {
        kind: "overlap_credit",
        description: "Overlap credit: Sara Ali, 30 days",
        creditMinor: 3000,
        amountMinor: -3000,
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
};

const getMock = mock((path: string) => {
  if (path === "/api/platform/tiers") return Promise.resolve({ data: { tiers } });
  if (path === "/api/platform/schools/{schoolId}") {
    return Promise.resolve({ data: { id: SCHOOL_ID, name: "Alpha Academy", currencyCode: "USD" } });
  }
  if (path === "/api/platform/schools/{schoolId}/licenses") {
    return Promise.resolve({ data: { licenses } });
  }
  if (path === "/api/platform/schools/{schoolId}/license-quotes") {
    return Promise.resolve({ data: { quotes: [quote] } });
  }
  if (path === "/api/platform/schools") {
    return Promise.resolve({ data: { schools: [], total: 0 } });
  }
  throw new Error(`Unhandled GET ${path}`);
});
const postMock = mock((path: string, _init?: { body?: Record<string, unknown> }) => {
  if (path === "/api/platform/licenses/quote") return Promise.resolve({ data: calculation });
  if (path === "/api/platform/schools/{schoolId}/license-quotes") {
    return Promise.resolve({ data: quote });
  }
  if (path === "/api/platform/schools/{schoolId}/license-quotes/{quoteId}/send") {
    return Promise.resolve({ data: { ...quote, status: "sent" } });
  }
  throw new Error(`Unhandled POST ${path}`);
});

mock.module("../../../lib/api", () => ({ api: { GET: getMock, POST: postMock } }));

const loadPage = async (): Promise<ComponentType> => (await import("./CalculatorPage")).default;

async function renderPage(search = `?schoolId=${SCHOOL_ID}`) {
  const Page = await loadPage();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={[`/portal/platform/quotes${search}`]}>
          <Routes>
            <Route path="/portal/platform/quotes" element={<Page />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function pricedBodies() {
  return postMock.mock.calls
    .filter(([path]) => path === "/api/platform/licenses/quote")
    .map(([, init]) => init!.body!);
}

async function chooseStudentSeats(seats: string) {
  fireEvent.click(await screen.findByRole("combobox", { name: "Students tier" }));
  fireEvent.click(screen.getByRole("option", { name: "Student Plus" }));
  fireEvent.change(screen.getByLabelText("Students seats"), { target: { value: seats } });
}

afterEach(() => {
  cleanup();
  licenses = [];
  getMock.mockClear();
  postMock.mockClear();
});

describe("CalculatorPage", () => {
  test("prices the settled terms and shows the whole breakdown", async () => {
    await renderPage();
    await chooseStudentSeats("80");

    await waitFor(() =>
      expect(
        pricedBodies().some(
          (body) =>
            (body.student as { seats: number } | undefined)?.seats === 80 &&
            (body.student as { planId: string }).planId === STUDENT_TIER,
        ),
      ).toBe(true),
    );
    const body = pricedBodies().at(-1)!;
    expect(body).toMatchObject({
      schoolId: SCHOOL_ID,
      kind: "new",
      currencyCode: "USD",
      months: 12,
      includeFamilyPlus: false,
      includeOverlapCredits: true,
      adjustment: null,
    });
    expect(body.licenseId).toBeUndefined();
    // Family+ is off, so no parent seats are priced.
    expect(body.parent).toBeUndefined();

    const breakdown = await screen.findByRole("region", { name: "Price breakdown" });
    await within(breakdown).findByText("Student Plus: 80 Students");
    const amountOf = (label: string | RegExp) =>
      within(within(breakdown).getByRole("rowheader", { name: label }).closest("tr")!).getByRole(
        "cell",
      ).textContent;
    expect(amountOf(/^Student Plus: 80 Students/)).toBe("$4,800.00");
    expect(within(breakdown).getByText("$5.00 → $4.28 per seat per month")).toBeTruthy();
    expect(amountOf("Volume discount (5%)")).toBe("-$240.00");
    expect(amountOf("Duration discount (10%)")).toBe("-$456.00");
    expect(amountOf("Overlap credit: Sara Ali, 30 days")).toBe("-$30.00");
    expect(amountOf("Adjustment: Loyal school")).toBe("-$10.00");
    expect(amountOf("List price")).toBe("$4,800.00");
    expect(amountOf("Overlap credits")).toBe("-$30.00");
    expect(amountOf("Total")).toBe("$4,064.00");
    expect(
      within(breakdown).getByText("You save $736.00 (15.33%) compared with list price."),
    ).toBeTruthy();
  });

  test("offers the next volume bracket as seats to add and the price per seat there", async () => {
    await renderPage();
    await chooseStudentSeats("80");

    const offer = await screen.findByRole("region", { name: "A better offer for more seats" });
    const row = within(offer).getByText("Add 20 seats to reach 10% off").closest("tr")!;
    expect(within(row).getByText("Students")).toBeTruthy();
    expect(within(row).getByText("$4.28")).toBeTruthy();
    expect(within(row).getByText("$4.05")).toBeTruthy();
  });

  test("an adjustment needs a reason before the quote can be saved", async () => {
    await renderPage();
    await chooseStudentSeats("80");
    const save = (await screen.findByRole("button", {
      name: "Save as draft quote",
    })) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));

    fireEvent.change(screen.getByLabelText(/Adjustment \(USD\)/), { target: { value: "-10" } });
    expect(await screen.findByText("An adjustment needs a reason.")).toBeTruthy();
    expect(save.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Loyal school" } });
    fireEvent.change(screen.getByLabelText("Notes for the school (optional)"), {
      target: { value: "Valid for this term only" },
    });
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);

    await waitFor(() =>
      expect(
        postMock.mock.calls.some(
          ([path]) => path === "/api/platform/schools/{schoolId}/license-quotes",
        ),
      ).toBe(true),
    );
    const [, init] = postMock.mock.calls.find(
      ([path]) => path === "/api/platform/schools/{schoolId}/license-quotes",
    )!;
    expect(init!.body).toMatchObject({
      kind: "new",
      currencyCode: "USD",
      months: 12,
      student: { planId: STUDENT_TIER, seats: 80 },
      adjustment: { amountMinor: -1000, reason: "Loyal school" },
      notes: "Valid for this term only",
    });
    // The school is in the path, not the body.
    expect(init!.body!.schoolId).toBeUndefined();
    expect(await screen.findByText("Quote saved as a draft.")).toBeTruthy();
  });

  test("lists the school's quotes with their status and sends a draft", async () => {
    await renderPage();
    const quotes = await screen.findByRole("region", { name: "Quotes" });
    const row = (await within(quotes).findByText("$4,064.00")).closest("tr")!;
    expect(within(row).getByText("Draft")).toBeTruthy();
    expect(within(row).getByText("New term")).toBeTruthy();

    fireEvent.click(within(row).getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(
        postMock.mock.calls.some(
          ([path]) => path === "/api/platform/schools/{schoolId}/license-quotes/{quoteId}/send",
        ),
      ).toBe(true),
    );
    expect(await screen.findByText("Quote sent to the school.")).toBeTruthy();
  });

  test("re-prices a draft license in place, starting from its terms", async () => {
    licenses = [
      {
        id: LICENSE_ID,
        schoolId: SCHOOL_ID,
        status: "draft",
        currencyCode: "USD",
        includeFamilyPlus: false,
        startsAt: "2026-12-01T00:00:00.000Z",
        endsAt: "2027-12-01T00:00:00.000Z",
        activatedAt: null,
        allowedTransitions: ["awaiting_payment", "cancelled"],
        audiences: [
          {
            audience: "student",
            purchased: 150,
            assigned: 0,
            tier: { id: STUDENT_TIER, code: "student_plus", displayName: "Student Plus" },
          },
          { audience: "teacher", purchased: 0, assigned: 0, tier: null },
          { audience: "parent", purchased: 0, assigned: 0, tier: null },
        ],
      },
    ];
    await renderPage(`?schoolId=${SCHOOL_ID}&licenseId=${LICENSE_ID}&kind=new`);

    await waitFor(() =>
      expect(pricedBodies().some((body) => body.licenseId === LICENSE_ID)).toBe(true),
    );
    expect(pricedBodies().at(-1)).toMatchObject({
      kind: "new",
      licenseId: LICENSE_ID,
      startsAt: "2026-12-01T00:00:00.000Z",
      student: { planId: STUDENT_TIER, seats: 150 },
    });
  });
});
