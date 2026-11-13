import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";

import { renderAs } from "./test-utils";

import type { ComponentType } from "react";

/**
 * Extra storage (`/portal/license/storage`): the school's usage against its cap, the two tiers with
 * monthly and yearly prices, buying (to the hosted checkout), switching tier behind a confirmation,
 * and stopping renewal -- the actions only for license:manage.
 */

const GIB = 1024 ** 3;
const P100M = "11111111-1111-4111-8111-111111111111";
const P100Y = "22222222-2222-4222-8222-222222222222";
const P1TM = "33333333-3333-4333-8333-333333333333";
const P1TY = "44444444-4444-4444-8444-444444444444";

let current: Record<string, unknown> | null = null;
let availableOnline = true;
let granted: { capBytes: number; endsAt: string } | null = null;

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
    default:
      throw new Error(`Unhandled GET ${path}`);
  }
});
const postMock = mock((path: string, init?: { body?: Record<string, unknown> }) => {
  switch (path) {
    case "/api/subscriptions/storage/checkout":
      return Promise.resolve({ data: { url: "https://checkout.example/s", sessionId: "cs_1" } });
    case "/api/subscriptions/storage/change":
      return Promise.resolve({ data: { ...current, priceId: init!.body!.priceId } });
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

async function renderPage(role = "PRINCIPAL") {
  const Page = await loadPage();
  return renderAs(role, <Page />, {
    path: "/portal/license/storage",
    at: "/portal/license/storage",
  });
}

afterEach(() => {
  cleanup();
  current = null;
  availableOnline = true;
  granted = null;
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

  test("upgrading sends the browser to the hosted checkout for that price", async () => {
    await renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Upgrade to 1 TB" }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://checkout.example/s"));
    const [, init] = postMock.mock.calls[0]! as [string, { body: Record<string, unknown> }];
    expect(init.body.priceId).toBe(P1TM);
  });

  test("a school with storage switches tier after confirming, and can stop renewing", async () => {
    current = {
      planCode: "storage_100gb",
      capBytes: 100 * GIB,
      status: "active",
      price: { id: P100M, amountMinor: 1000, currency: "USD", interval: "monthly" },
      currentPeriodEnd: "2026-12-12T00:00:00.000Z",
      cancelAtPeriodEnd: false,
    };
    await renderPage();

    expect(await screen.findByText("Your current plan")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Switch to 1 TB" }));
    const dialog = await screen.findByRole("dialog", { name: "Switch to 1 TB?" });
    expect(dialog.textContent).toContain("charged now");
    fireEvent.click(within(dialog).getByRole("button", { name: "Switch" }));
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith("/api/subscriptions/storage/change", {
        body: { priceId: P1TM },
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Stop renewing" }));
    await waitFor(() => expect(postMock).toHaveBeenCalledWith("/api/subscriptions/storage/cancel"));
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
