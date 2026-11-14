import { ApiError } from "@studafy/api-client";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";

import { renderAs } from "./test-utils";

import type { ComponentType } from "react";

/**
 * Extra storage (`/portal/license/storage`): the school's usage against its cap, the two tiers with
 * monthly and yearly prices, buying (to the hosted checkout) after a confirmation naming the price,
 * switching tier for the exact previewed amount, and stopping renewal behind a confirmation -- the
 * actions only for license:manage, and none of them able to run twice from a double click.
 */

const GIB = 1024 ** 3;
const P100M = "11111111-1111-4111-8111-111111111111";
const P100Y = "22222222-2222-4222-8222-222222222222";
const P1TM = "33333333-3333-4333-8333-333333333333";
const P1TY = "44444444-4444-4444-8444-444444444444";

let current: Record<string, unknown> | null = null;
let availableOnline = true;
let granted: { capBytes: number; endsAt: string } | null = null;
/** Each preview's amount due now; the next change answers PRICE_CHANGED when `changeRefusals` > 0. */
let previewAmounts: number[] = [];
let changeRefusals = 0;
/** When the previewed change takes effect: at once with a charge, or at the next renewal. */
let previewTiming: "now" | "renewal" = "now";

const BILLING = {
  paymentMethod: { brand: "visa", last4: "4242", expMonth: 3, expYear: 2029 },
  nextBill: { amountMinor: 1000, currency: "USD", at: "2026-12-12T00:00:00.000Z" },
  invoices: [
    {
      id: "in_1",
      number: "S-1",
      status: "paid",
      created: "2026-11-14T10:46:00.000Z",
      amountDueMinor: 1000,
      amountPaidMinor: 1000,
      amountRefundedMinor: 0,
      currency: "USD",
      billingReason: "subscription_create",
      hostedInvoiceUrl: "https://invoice.example/in_1",
      invoicePdf: null,
    },
    {
      id: "in_2",
      number: "S-2",
      status: "paid",
      created: "2026-11-14T14:33:00.000Z",
      amountDueMinor: 3879,
      amountPaidMinor: 3879,
      amountRefundedMinor: 3879,
      currency: "USD",
      billingReason: "subscription_update",
      hostedInvoiceUrl: null,
      invoicePdf: null,
    },
  ],
};

function priceChanged() {
  return new ApiError({
    status: 409,
    title: "Conflict",
    code: "STORAGE_ADDON_PRICE_CHANGED",
    detail: "The price of this change has changed since you saw it.",
    instance: null,
    type: null,
    request_id: null,
    problem: null,
  });
}

function offer() {
  return {
    usage: {
      usedBytes: Math.round(8.2 * GIB),
      capBytes: current ? (current.capBytes as number) : 10 * GIB,
      includedBytes: 10 * GIB,
    },
    current,
    currency: "USD",
    availableOnline,
    granted,
    tiers: [
      {
        planCode: "storage_100gb",
        capBytes: 100 * GIB,
        prices: [
          { id: P100M, amountMinor: 1000, currency: "USD", interval: "monthly" },
          { id: P100Y, amountMinor: 10000, currency: "USD", interval: "yearly" },
        ],
      },
      {
        planCode: "storage_1tb",
        capBytes: 1024 * GIB,
        prices: [
          { id: P1TM, amountMinor: 4900, currency: "USD", interval: "monthly" },
          { id: P1TY, amountMinor: 49000, currency: "USD", interval: "yearly" },
        ],
      },
    ],
  };
}

const getMock = mock((path: string) => {
  switch (path) {
    case "/api/subscriptions/storage/offer":
      return Promise.resolve({ data: offer() });
    case "/api/school/license":
      return Promise.resolve({ data: { license: null, usage: [], openChangeRequests: [] } });
    case "/api/school/license/invoices":
      return Promise.resolve({ data: { invoices: [] } });
    case "/api/subscriptions/storage/billing":
      return Promise.resolve({ data: current ? BILLING : null });
    default:
      throw new Error(`Unhandled GET ${path}`);
  }
});
const postMock = mock((path: string, init?: { body?: Record<string, unknown> }) => {
  switch (path) {
    case "/api/subscriptions/storage/checkout":
      return Promise.resolve({ data: { url: "https://checkout.example/s", sessionId: "cs_1" } });
    case "/api/subscriptions/storage/change/preview":
      return Promise.resolve({
        data: {
          timing: previewTiming,
          effectiveAt:
            previewTiming === "now" ? "2026-11-14T10:00:00.000Z" : "2026-12-12T00:00:00.000Z",
          amountDueNowMinor: previewTiming === "now" ? (previewAmounts.shift() ?? 3871) : 0,
          nextBillMinor: 4900,
          nextBillAt: "2026-12-12T00:00:00.000Z",
          currency: "USD",
          chargeNow: previewTiming === "now",
          price: {
            id: init!.body!.priceId,
            amountMinor: 4900,
            currency: "USD",
            interval: "monthly",
          },
          capBytes: 1024 * GIB,
          prorationDate: "2026-11-14T10:00:00.000Z",
        },
      });
    case "/api/subscriptions/storage/change":
      if (changeRefusals > 0) {
        changeRefusals -= 1;
        return Promise.reject(priceChanged());
      }
      return Promise.resolve({
        data: {
          ...current,
          pendingChange:
            previewTiming === "renewal"
              ? {
                  planCode: "storage_100gb",
                  capBytes: 100 * GIB,
                  price: null,
                  effectiveAt: "2026-12-12T00:00:00.000Z",
                }
              : null,
        },
      });
    case "/api/subscriptions/storage/change/undo":
      return Promise.resolve({ data: { ...current, pendingChange: null } });
    case "/api/subscriptions/storage/payment-method":
      return Promise.resolve({ data: { url: "https://billing.example/portal" } });
    case "/api/subscriptions/storage/cancel":
      return Promise.resolve({
        data: { cancelAtPeriodEnd: true, currentPeriodEnd: "2026-12-12T00:00:00.000Z" },
      });
    default:
      throw new Error(`Unhandled POST ${path}`);
  }
});
mock.module("../../lib/api", () => ({ api: { GET: getMock, POST: postMock } }));

const assign = mock((_url: string) => undefined);
Object.defineProperty(window, "location", {
  configurable: true,
  value: { ...window.location, href: "http://localhost/portal/license/storage", assign },
});

const loadPage = async (): Promise<ComponentType> => (await import("./StoragePage")).default;

async function renderPage(role = "PRINCIPAL", at = "/portal/license/storage") {
  const Page = await loadPage();
  return renderAs(role, <Page />, { path: "/portal/license/storage", at });
}

function posts(path: string) {
  return postMock.mock.calls.filter(([called]) => called === path);
}

function withStorage() {
  current = {
    planCode: "storage_100gb",
    capBytes: 100 * GIB,
    status: "active",
    price: { id: P100M, amountMinor: 1000, currency: "USD", interval: "monthly" },
    currentPeriodEnd: "2026-12-12T00:00:00.000Z",
    cancelAtPeriodEnd: false,
    pendingChange: null,
  };
}

afterEach(() => {
  cleanup();
  current = null;
  availableOnline = true;
  granted = null;
  previewAmounts = [];
  changeRefusals = 0;
  previewTiming = "now";
  getMock.mockClear();
  postMock.mockClear();
  assign.mockClear();
});

describe("StoragePage", () => {
  test("shows usage against the included storage and both tiers at their prices", async () => {
    await renderPage();

    expect(await screen.findByText("8.2 GB of 10 GB used")).toBeTruthy();
    expect(screen.getByText("Your plan includes 10 GB.")).toBeTruthy();
    expect(screen.getByText("$10.00 per month")).toBeTruthy();
    expect(screen.getByText("$49.00 per month")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Yearly (2 months free)"));
    expect(screen.getByText("$100.00 per year")).toBeTruthy();
    expect(screen.getByText("$490.00 per year")).toBeTruthy();
  });

  test("upgrading names the price first, then sends the browser to the checkout once", async () => {
    await renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Upgrade to 1 TB" }));
    const dialog = await screen.findByRole("dialog", { name: "Upgrade to 1 TB?" });
    expect(dialog.textContent).toContain("You'll pay $49.00 today");
    expect(dialog.textContent).toContain("then $49.00 every month");
    expect(posts("/api/subscriptions/storage/checkout")).toHaveLength(0);

    const pay = within(dialog).getByRole("button", { name: "Continue to payment" });
    fireEvent.click(pay);
    fireEvent.click(pay);

    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://checkout.example/s"));
    const checkouts = posts("/api/subscriptions/storage/checkout");
    expect(checkouts).toHaveLength(1);
    const [, init] = checkouts[0]! as [string, { body: Record<string, unknown> }];
    expect(init.body.priceId).toBe(P1TM);
  });

  test("switching shows the exact amount due today and charges only that, once", async () => {
    withStorage();
    await renderPage();

    expect(await screen.findByText("Your current plan")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Switch to 1 TB" }));
    const dialog = await screen.findByRole("dialog", { name: "Switch to 1 TB?" });
    expect(await within(dialog).findByText("Charged today: $38.71")).toBeTruthy();
    expect(dialog.textContent).toContain("Then $49.00 per month");

    const pay = within(dialog).getByRole("button", { name: "Pay $38.71 and switch" });
    fireEvent.click(pay);
    fireEvent.click(pay);

    await waitFor(() => expect(posts("/api/subscriptions/storage/change")).toHaveLength(1));
    const [, init] = posts("/api/subscriptions/storage/change")[0]! as [
      string,
      { body: Record<string, unknown> },
    ];
    expect(init.body).toMatchObject({
      priceId: P1TM,
      prorationDate: "2026-11-14T10:00:00.000Z",
      expectedAmountMinor: 3871,
    });
    expect(typeof init.body.requestKey).toBe("string");
  });

  test("when the amount moved, nothing is charged and the new amount is shown to confirm", async () => {
    withStorage();
    previewAmounts = [3871, 3902];
    changeRefusals = 1;
    await renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Switch to 1 TB" }));
    const dialog = await screen.findByRole("dialog", { name: "Switch to 1 TB?" });
    fireEvent.click(await within(dialog).findByRole("button", { name: "Pay $38.71 and switch" }));

    expect(
      await within(dialog).findByText(/The amount changed since you opened this/),
    ).toBeTruthy();
    expect(await within(dialog).findByText("Charged today: $39.02")).toBeTruthy();
    const first = posts("/api/subscriptions/storage/change")[0]! as [
      string,
      { body: Record<string, unknown> },
    ];

    fireEvent.click(within(dialog).getByRole("button", { name: "Pay $39.02 and switch" }));
    await waitFor(() => expect(posts("/api/subscriptions/storage/change")).toHaveLength(2));
    const second = posts("/api/subscriptions/storage/change")[1]! as [
      string,
      { body: Record<string, unknown> },
    ];
    expect(second[1].body.expectedAmountMinor).toBe(3902);
    expect(second[1].body.requestKey).not.toBe(first[1].body.requestKey);
  });

  test("canceling says what happens and waits for one plain confirmation", async () => {
    withStorage();
    await renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Cancel subscription" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Cancel your storage subscription?",
    });
    expect(dialog.textContent).toContain("Your 100 GB stays until");
    expect(dialog.textContent).toContain("No files are deleted");
    expect(posts("/api/subscriptions/storage/cancel")).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel subscription" }));
    await waitFor(() => expect(posts("/api/subscriptions/storage/cancel")).toHaveLength(1));
  });

  test("manage subscription shows the plan, next bill, card and every bill", async () => {
    withStorage();
    await renderPage();

    expect(await screen.findByRole("heading", { name: "Manage subscription" })).toBeTruthy();
    expect(await screen.findByText("Visa ending in 4242 (expires 03/2029)")).toBeTruthy();
    expect(screen.getByTestId("storage-next-bill").textContent).toContain("$10.00 on");
    const history = screen.getByRole("table", { name: "Billing history" });
    expect(within(history).getByText("First payment")).toBeTruthy();
    expect(within(history).getByText("Plan change")).toBeTruthy();
    expect(within(history).getByText("($38.79 refunded)")).toBeTruthy();
    expect(within(history).getByRole("link", { name: "View receipt" }).getAttribute("href")).toBe(
      "https://invoice.example/in_1",
    );
  });

  test("update card opens the payment provider's card page once", async () => {
    withStorage();
    await renderPage();

    const update = await screen.findByRole("button", { name: "Update card" });
    fireEvent.click(update);
    fireEvent.click(update);

    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://billing.example/portal"));
    expect(posts("/api/subscriptions/storage/payment-method")).toHaveLength(1);
  });

  test("moving down is scheduled for the renewal, charges nothing and can be undone", async () => {
    withStorage();
    current!.planCode = "storage_1tb";
    current!.capBytes = 1024 * GIB;
    current!.price = { id: P1TM, amountMinor: 4900, currency: "USD", interval: "monthly" };
    previewTiming = "renewal";
    await renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Switch to 100 GB" }));
    const dialog = await screen.findByRole("dialog", { name: "Switch to 100 GB?" });
    expect(await within(dialog).findByText("Nothing is charged today.")).toBeTruthy();
    expect(dialog.textContent).toContain("Your school keeps 1 TB until");
    const confirm = within(dialog).getByRole("button", { name: /^Change on / });
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    await waitFor(() => expect(posts("/api/subscriptions/storage/change")).toHaveLength(1));
    const [, init] = posts("/api/subscriptions/storage/change")[0]! as [
      string,
      { body: Record<string, unknown> },
    ];
    expect(init.body.expectedAmountMinor).toBe(0);
  });

  test("a scheduled change shows when it happens, blocks other changes, and can be undone", async () => {
    withStorage();
    current!.pendingChange = {
      planCode: "storage_100gb",
      capBytes: 100 * GIB,
      price: { id: P100Y, amountMinor: 10000, currency: "USD", interval: "yearly" },
      effectiveAt: "2026-12-12T00:00:00.000Z",
    };
    await renderPage();

    expect(await screen.findByText(/Changing to 100 GB on/)).toBeTruthy();
    const switchTo = screen.getByRole("button", { name: "Switch to 1 TB" }) as HTMLButtonElement;
    expect(switchTo.disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Keep 100 GB" }));
    await waitFor(() => expect(posts("/api/subscriptions/storage/change/undo")).toHaveLength(1));
  });

  test("back from a paid checkout, nothing can be bought until the payment is confirmed", async () => {
    await renderPage("PRINCIPAL", "/portal/license/storage?checkout=success");

    expect(await screen.findByText("We're confirming your payment…")).toBeTruthy();
    const upgrade = screen.getByRole("button", { name: "Upgrade to 1 TB" }) as HTMLButtonElement;
    expect(upgrade.disabled).toBe(true);
  });

  test("without license:manage the tiers show no buy buttons", async () => {
    await renderPage("FINANCE");

    expect(await screen.findByText("$10.00 per month")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Upgrade to/ })).toBeNull();
  });

  test("storage Studafy granted by hand is shown with its end date", async () => {
    granted = { capBytes: 100 * GIB, endsAt: "2027-11-13T00:00:00.000Z" };
    await renderPage();

    expect(await screen.findByText(/Granted by Studafy: 100 GB until/)).toBeTruthy();
  });

  test("a school that cannot buy online is told to contact Studafy", async () => {
    availableOnline = false;
    await renderPage();

    expect(await screen.findByText(/can't be bought online for your school yet/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Upgrade to/ })).toBeNull();
  });
});
