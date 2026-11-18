import { cleanup, screen, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";

import { expectNoA11yViolations } from "../../../lib/test/axe";
import { dashboard, entry, ledger } from "../../ai-programme/test-fixtures";
import { renderAs } from "../../license/test-utils";

import type { ComponentType } from "react";

/**
 * Finance's Student AI earnings: what the school owes and paid Studafy, the revenue share per
 * period (collected -> conversion % + bonus % = total % -> amount) with the invoice each credit went
 * on, payouts, and the year's total earnings with what each part counts.
 */

let summary: Record<string, unknown> = dashboard();
let book: Record<string, unknown> = ledger();

const getMock = mock((path: string) => {
  switch (path) {
    case "/api/school/ai-revenue-share/summary":
      return Promise.resolve({ data: summary });
    case "/api/school/ai-revenue-share":
      return Promise.resolve({ data: book });
    default:
      throw new Error(`Unhandled GET ${path}`);
  }
});

mock.module("../../../lib/api", () => ({ api: { GET: getMock } }));

const loadPage = async (): Promise<ComponentType> =>
  (await import("./StudentAiEarningsPage")).default;

async function renderPage() {
  const Page = await loadPage();
  return renderAs("FINANCE", <Page />, {
    path: "/portal/finance/student-ai",
    at: "/portal/finance/student-ai",
  });
}

const stat = (key: string) => screen.getByTestId(`stat-${key}`).querySelector("dd")!.textContent;

afterEach(() => {
  cleanup();
  summary = dashboard();
  book = ledger();
  getMock.mockClear();
});

describe("StudentAiEarningsPage", () => {
  test("owed and paid to Studafy, the share earned and the year's total", async () => {
    await renderPage();
    expect(await screen.findByTestId("stat-owed")).toBeTruthy();
    expect(stat("owed")).toBe("$1,400.00");
    expect(stat("paid")).toBe("$12,600.00");
    expect(screen.getByTestId("stat-paid").textContent).toContain("Of $14,000.00 invoiced");
    expect(stat("share")).toBe("$1,820.00");
    expect(stat("total")).toBe("$8,820.00");
    const earnings = screen.getByTestId("earnings");
    expect(within(earnings).getByTestId("earnings-share").textContent).toBe("$1,820.00");
    expect(within(earnings).getByTestId("earnings-margin").textContent).toBe("$7,000.00");
    expect(within(earnings).getByTestId("earnings-total").textContent).toBe("$8,820.00");
    expect(
      screen
        .getByRole("link", { name: "Student AI on tuition (auto-billing and lines)" })
        .getAttribute("href"),
    ).toBe("/portal/finance/settings/student-ai");
  });

  test("the share per period: collected -> 10% + 3% = 13% -> amount, and where it went", async () => {
    await renderPage();
    const table = await screen.findByTestId("share-periods");
    const formulas = within(table).getAllByRole("img");
    expect(formulas[0]!.getAttribute("aria-label")).toBe(
      "Collected $1,400.00, conversion 10% plus bonus 3% equals 13%, share $182.00",
    );
    const rows = within(table).getAllByRole("row").slice(1);
    // Newest period first; the earlier share was credited on the school's next invoice.
    expect(rows[0]!.textContent).toContain("Owed");
    expect(rows[0]!.textContent).toContain("Credited on the next invoice");
    expect(rows[1]!.textContent).toContain("Credited on invoice LIC-2026-000010");
    expect(rows[1]!.textContent).toContain("Invoice LIC-2026-000001, instalment 1");
  });

  test("a forfeited or pending share says why", async () => {
    book = ledger({
      entries: [
        entry(3, { status: "forfeited", forfeitReason: "late_payment", amountMinor: 0 }),
        entry(2, { status: "pending", conversionPending: true, totalBps: 300, amountMinor: 0 }),
      ],
    });
    await renderPage();
    const table = await screen.findByTestId("share-periods");
    expect(table.textContent).toContain("Forfeited: the instalment was paid after its cutoff");
    expect(table.textContent).toContain("Waits for the conversion to be locked");
  });

  test("payouts from Studafy, and nothing yet", async () => {
    book = ledger({
      payouts: [
        {
          id: "f0000000-0000-4000-8000-000000000001",
          currencyCode: "USD",
          amountMinor: 36_400,
          reference: "FT-OUT-1",
          paidOn: "2026-11-10",
          note: null,
          recordedBy: "f0000000-0000-4000-8000-000000000002",
          createdAt: "2026-11-10T09:00:00.000Z",
        },
      ],
    });
    await renderPage();
    const payouts = await screen.findByTestId("payouts");
    expect(payouts.textContent).toContain("FT-OUT-1");
    expect(payouts.textContent).toContain("$364.00");
    cleanup();
    book = ledger({ entries: [], payouts: [] });
    await renderPage();
    expect(await screen.findByText(/No revenue share yet/)).toBeTruthy();
    expect(screen.getByText(/No payouts yet/)).toBeTruthy();
  });

  test("has no accessibility violations", async () => {
    const { container } = await renderPage();
    await screen.findByTestId("share-periods");
    await expectNoA11yViolations(container);
  });
});
