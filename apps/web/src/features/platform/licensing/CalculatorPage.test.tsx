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
  commitment: "full_year",
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
  paymentPlan: "in_full",
  schedulePreview: [{ position: 1, amountMinor: 0, dueDate: "2026-12-01" }],
  scheduleErrors: [] as string[],
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
  termsChanges: [] as string[],
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

let extraQuotes: Record<string, unknown>[] = [];
let termsChanges: string[] = [];
const REQUEST_ID = "99999999-9999-4999-8999-999999999999";
const schoolRequest = {
  id: REQUEST_ID,
  schoolId: SCHOOL_ID,
  schoolName: "Alpha Academy",
  licenseId: null,
  status: "open",
  studentSeats: 80,
  teacherSeats: null,
  parentSeats: null,
  includeFamilyPlus: null,
  studentTier: null,
  teacherTier: null,
  parentTier: null,
  note: "AI for grade 10",
  requestedBy: "44444444-4444-4444-8444-444444444444",
  resolutionNote: null,
  resolvedAt: null,
  createdAt: "2026-10-20T09:00:00.000Z",
  months: 24,
  startsOn: "2027-01-10",
  paymentPlan: "yearly",
  paymentProposal: null,
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
    return Promise.resolve({ data: { quotes: [quote, ...extraQuotes] } });
  }
  if (path === "/api/platform/schools") {
    return Promise.resolve({ data: { schools: [], total: 0 } });
  }
  if (path === "/api/platform/licenses/change-requests") {
    return Promise.resolve({ data: { requests: [schoolRequest] } });
  }
  throw new Error(`Unhandled GET ${path}`);
});
const postMock = mock((path: string, _init?: { body?: Record<string, unknown> }) => {
  if (path === "/api/platform/licenses/quote") {
    return Promise.resolve({ data: { ...calculation, termsChanges } });
  }
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
  termsChanges = [];
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
    // Left unset, the API keeps the licence's commitment.
    expect(init!.body!.commitment).toBeUndefined();
    expect(await screen.findByText("Quote saved as a draft.")).toBeTruthy();
  });

  test("a quote can be made month to month", async () => {
    await renderPage();
    await chooseStudentSeats("80");
    const save = (await screen.findByRole("button", {
      name: "Save as draft quote",
    })) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));

    fireEvent.click(screen.getByRole("combobox", { name: "Commitment" }));
    fireEvent.click(screen.getByRole("option", { name: "Month to month" }));
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
    expect(init!.body!.commitment).toBe("month_to_month");
  });

  test("a custom payment schedule is priced, checked and saved with the quote", async () => {
    await renderPage();
    await chooseStudentSeats("80");
    const save = (await screen.findByRole("button", {
      name: "Save as draft quote",
    })) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));

    fireEvent.click(screen.getByRole("combobox", { name: "Payment plan" }));
    fireEvent.click(screen.getByRole("option", { name: "Custom schedule" }));
    // Until every instalment has an amount and a date, nothing can be saved.
    expect(
      await screen.findByText("Give every instalment an amount above zero and a due date."),
    ).toBeTruthy();
    expect(save.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Instalment 1 amount (USD)"), {
      target: { value: "2032" },
    });
    fireEvent.change(screen.getByLabelText("Instalment 1 due on"), {
      target: { value: "2026-12-01" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add an instalment" }));
    fireEvent.change(screen.getByLabelText("Instalment 2 amount (USD)"), {
      target: { value: "2032" },
    });
    fireEvent.change(screen.getByLabelText("Instalment 2 due on"), {
      target: { value: "2027-03-01" },
    });

    await waitFor(() =>
      expect(pricedBodies().at(-1)).toMatchObject({
        paymentPlan: "custom",
        paymentSchedule: [
          { amountMinor: 203_200, dueDate: "2026-12-01" },
          { amountMinor: 203_200, dueDate: "2027-03-01" },
        ],
      }),
    );
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
    expect(init!.body).toMatchObject({ paymentPlan: "custom" });
    expect((init!.body!.paymentSchedule as unknown[]).length).toBe(2);
  });

  test("lists the school's quotes with their status and sends a draft", async () => {
    await renderPage();
    const quotes = await screen.findByRole("region", { name: "Quotes" });
    const row = (await within(quotes).findByText("$4,064.00")).closest("tr")!;
    expect(within(row).getByText("Draft")).toBeTruthy();
    expect(within(row).getByText("New term")).toBeTruthy();
    expect(within(row).getByTestId("quote-commitment").textContent).toBe("Full year committed");

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

  test("a quote the school declined shows it, with the school's reason, and no actions", async () => {
    extraQuotes = [
      {
        ...quote,
        id: "q-declined",
        status: "declined",
        totalMinor: 99_900,
        declinedAt: "2026-11-14T10:00:00.000Z",
        declineReason: "We only need 10 seats",
      },
      {
        ...quote,
        id: "q-declined-silent",
        status: "declined",
        totalMinor: 88_800,
        declinedAt: "2026-11-14T11:00:00.000Z",
        declineReason: null,
      },
    ];
    try {
      await renderPage();
      const quotes = await screen.findByRole("region", { name: "Quotes" });
      const row = (await within(quotes).findByText("$999.00")).closest("tr")!;
      expect(within(row).getByText("Declined by the school")).toBeTruthy();
      expect(within(row).getByText("Reason: “We only need 10 seats”")).toBeTruthy();
      expect(within(row).queryByRole("button")).toBeNull();
      const silent = within(quotes).getByText("$888.00").closest("tr")!;
      expect(within(silent).getByText("No reason given.")).toBeTruthy();
    } finally {
      extraQuotes = [];
    }
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
  test("prices a school's AI request from the inbox: students only, prefilled", async () => {
    await renderPage(`?schoolId=${SCHOOL_ID}&studentSeats=120&studentTier=${STUDENT_TIER}`);

    expect(((await screen.findByLabelText("Students seats")) as HTMLInputElement).value).toBe(
      "120",
    );
    // Teacher seats and Family+ are not sold yet: no row and no checkbox for them.
    expect(screen.queryByLabelText("Teachers seats")).toBeNull();
    expect(screen.queryByLabelText("Parents (Family+) seats")).toBeNull();
    expect(screen.queryByLabelText(/Include Family\+/)).toBeNull();

    await waitFor(() =>
      expect(
        pricedBodies().some(
          (body) =>
            (body.student as { seats: number } | undefined)?.seats === 120 &&
            (body.student as { planId: string }).planId === STUDENT_TIER,
        ),
      ).toBe(true),
    );
    const body = pricedBodies().at(-1)!;
    expect(body.teacher).toBeUndefined();
    expect(body.parent).toBeUndefined();
    expect(body.includeFamilyPlus).toBe(false);
  });

  test("starts from the school's request: its length, start and plan; a change needs a reason", async () => {
    await renderPage(
      `?schoolId=${SCHOOL_ID}&requestId=${REQUEST_ID}&studentSeats=80&studentTier=${STUDENT_TIER}`,
    );
    const card = within(await screen.findByTestId("school-request"));
    expect(await card.findByText("24 months")).toBeTruthy();
    expect(card.getByText("Jan 10, 2027")).toBeTruthy();
    expect(card.getByText("Yearly, one payment per licence year")).toBeTruthy();

    expect(((await screen.findByLabelText("Months")) as HTMLInputElement).value).toBe("24");
    expect((screen.getByLabelText("Starts on") as HTMLInputElement).value).toBe("2027-01-10");
    await waitFor(() =>
      expect(pricedBodies().at(-1)).toMatchObject({
        months: 24,
        paymentPlan: "yearly",
        changeRequestId: REQUEST_ID,
      }),
    );
    expect(
      await screen.findByText("These terms follow the school's chosen length and payment plan."),
    ).toBeTruthy();

    // The super admin shortens it: the API reports the change, and saving needs a reason.
    termsChanges = ["months"];
    fireEvent.change(screen.getByLabelText("Months"), { target: { value: "12" } });
    expect(
      await screen.findByText(/These terms change the school's choice \(length\)/),
    ).toBeTruthy();
    const save = screen.getByRole("button", { name: "Save as draft quote" }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(true));
    fireEvent.change(screen.getByLabelText("Why change what the school chose?"), {
      target: { value: "Twelve months this year" },
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
      months: 12,
      paymentPlan: "yearly",
      changeRequestId: REQUEST_ID,
      termsChangeReason: "Twelve months this year",
    });
  });
});
