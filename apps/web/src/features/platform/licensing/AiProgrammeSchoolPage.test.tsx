import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";

import {
  LICENSE_ID,
  SCHOOL_ID,
  dashboard,
  ledger,
  platformDashboard,
  uploads,
} from "../../ai-programme/test-fixtures";
import { renderAs } from "../../license/test-utils";

import type { ComponentType } from "react";

/**
 * One school in the console: its figures and what Studafy keeps per seat; the licence's conversion
 * measurements and re-measuring (with a reason) before the lock; the ledger by status; recompute;
 * recording a payout of what is due; upload consistency; and links to its licence and settings.
 */

interface Init {
  params?: { path?: Record<string, string>; query?: Record<string, string> };
  body?: Record<string, unknown>;
}

let book: Record<string, unknown> = ledger();
let locked = true;

function licenceShare() {
  const snapshot = {
    id: "s0000000-0000-4000-8000-000000000001",
    periodStart: "2026-09-01",
    measureOn: "2026-10-01",
    asOf: "2026-10-01",
    enrolledCount: 500,
    optedInCount: 350,
    conversionBps: 7000,
    seats: 350,
    conversionShareBps: 1000,
    floorApplied: false,
    locked: true,
    source: "scheduled",
    reason: null,
    measuredBy: null,
    measuredAt: "2026-10-01T01:00:00.000Z",
  };
  return {
    licenseId: LICENSE_ID,
    currencyCode: "USD",
    commitment: "full_year",
    periods: [
      {
        periodStart: "2026-09-01",
        measureOn: "2026-10-01",
        locked: locked ? snapshot : null,
        measurements: locked
          ? [snapshot]
          : [{ ...snapshot, locked: false, source: "super_admin", reason: "Late roster import" }],
      },
    ],
    rate: {
      periodStart: "2026-09-01",
      conversionSource: locked ? "locked" : "provisional",
      conversionBps: 7000,
      conversionShareBps: 1000,
      floorApplied: false,
      multiplierBps: 10000,
      maxShareBps: 1500,
      payoutMode: "invoice_credit",
    },
    totals: [],
    entries: [],
  };
}

const getMock = mock((path: string, init?: Init) => {
  switch (path) {
    case "/api/platform/schools/{schoolId}/ai-revenue-share/summary":
      return Promise.resolve({ data: platformDashboard() });
    case "/api/platform/schools/{schoolId}/ai-revenue-share":
      return Promise.resolve({ data: { ...book, status: init?.params?.query?.status ?? null } });
    case "/api/platform/schools/{schoolId}/licenses/{licenseId}/ai-revenue-share":
      return Promise.resolve({ data: licenceShare() });
    case "/api/platform/schools/{schoolId}/ai-programme/upload-consistency":
      return Promise.resolve({ data: uploads() });
    default:
      throw new Error(`Unhandled GET ${path}`);
  }
});

const postMock = mock((path: string) => {
  switch (path) {
    case "/api/platform/schools/{schoolId}/ai-revenue-share/recompute":
      return Promise.resolve({
        data: { recorded: 1, resolved: 2, settled: 3, revenueShare: book },
      });
    case "/api/platform/schools/{schoolId}/ai-revenue-share/payouts":
      return Promise.resolve({ data: { id: "x" } });
    case "/api/platform/schools/{schoolId}/licenses/{licenseId}/ai-revenue-share/measure":
      return Promise.resolve({ data: licenceShare() });
    default:
      throw new Error(`Unhandled POST ${path}`);
  }
});

mock.module("../../../lib/api", () => ({ api: { GET: getMock, POST: postMock } }));

const loadPage = async (): Promise<ComponentType> =>
  (await import("./AiProgrammeSchoolPage")).default;

async function renderPage() {
  const Page = await loadPage();
  return renderAs("SUPER_ADMIN", <Page />, {
    path: "/portal/platform/ai-programme/schools/:schoolId",
    at: `/portal/platform/ai-programme/schools/${SCHOOL_ID}`,
  });
}

const stat = (key: string) => screen.getByTestId(`stat-${key}`).querySelector("dd")!.textContent;
const callsTo = (path: string) =>
  postMock.mock.calls.filter(([p]) => p === path) as unknown as [string, Init][];

afterEach(() => {
  cleanup();
  book = ledger();
  locked = true;
  getMock.mockClear();
  postMock.mockClear();
});

describe("AiProgrammeSchoolPage", () => {
  test("the school's figures, Studafy's net per seat, and links to its licence and settings", async () => {
    await renderPage();
    expect(await screen.findByRole("heading", { name: "Student AI: Atlas Academy" })).toBeTruthy();
    expect(stat("students")).toBe("350 / 500");
    expect(stat("conversion")).toBe("70%");
    expect(stat("rate")).toBe("13%");
    expect(stat("net")).toBe("$34.80");
    expect(screen.getByTestId("stat-net").textContent).toContain(
      "$14,000.00 collected − share = $12,180.00, over 350 seats",
    );
    expect(screen.getByRole("link", { name: "School and licence" }).getAttribute("href")).toBe(
      `/portal/platform/schools/${SCHOOL_ID}`,
    );
    expect(
      screen.getByRole("link", { name: "The school's programme settings" }).getAttribute("href"),
    ).toBe(`/portal/platform/ai-programme?schoolId=${SCHOOL_ID}`);
    expect(screen.getByTestId("earnings-total").textContent).toBe("$8,820.00");
  });

  test("measurements: locked periods can't be measured again", async () => {
    await renderPage();
    const table = await screen.findByTestId("measurements");
    expect(table.textContent).toContain("350 of 500 = 70% → 10%");
    expect(screen.getByText(/This period's conversion is locked/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Measure again" })).toBeNull();
  });

  test("before the lock: measure again with a reason", async () => {
    locked = false;
    await renderPage();
    const button = await screen.findByRole("button", { name: "Measure again" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect((await screen.findByTestId("measurements")).textContent).toContain("Late roster import");
    fireEvent.change(screen.getByLabelText(/Reason/), {
      target: { value: "Students imported late" },
    });
    fireEvent.click(button);
    await waitFor(() =>
      expect(
        callsTo("/api/platform/schools/{schoolId}/licenses/{licenseId}/ai-revenue-share/measure"),
      ).toHaveLength(1),
    );
    const [, init] = callsTo(
      "/api/platform/schools/{schoolId}/licenses/{licenseId}/ai-revenue-share/measure",
    )[0]!;
    expect(init.body).toEqual({ reason: "Students imported late", periodStart: "2026-09-01" });
    expect(init.params?.path).toEqual({ schoolId: SCHOOL_ID, licenseId: LICENSE_ID });
  });

  test("the ledger by status, and recompute", async () => {
    await renderPage();
    const table = await screen.findByTestId("ledger");
    expect(
      within(table)
        .getAllByTestId("share-status")
        .map((p) => p.textContent),
    ).toEqual(["Owed", "Credited"]);
    expect(table.textContent).toContain("Credited on invoice LIC-2026-000010");
    fireEvent.click(screen.getByRole("button", { name: "Recompute" }));
    await waitFor(() =>
      expect(callsTo("/api/platform/schools/{schoolId}/ai-revenue-share/recompute")).toHaveLength(
        1,
      ),
    );
    expect(await screen.findByText("1 recorded, 2 worked out, 3 settled.")).toBeTruthy();
  });

  test("records a payout of exactly what is due, with the transfer's reference", async () => {
    const totals = { ...(dashboard().ledger as object), payoutDueMinor: 36_400 };
    book = ledger({ totals: [totals] });
    await renderPage();
    expect((await screen.findByTestId("payout-due")).textContent).toBe(
      "$364.00 is due to be paid out to the school.",
    );
    fireEvent.change(screen.getByLabelText(/Transfer reference/), {
      target: { value: "FT-OUT-9" },
    });
    fireEvent.change(screen.getByLabelText(/Paid on/), { target: { value: "2026-11-15" } });
    fireEvent.click(screen.getByRole("button", { name: "Record payout" }));
    await waitFor(() =>
      expect(callsTo("/api/platform/schools/{schoolId}/ai-revenue-share/payouts")).toHaveLength(1),
    );
    const [, init] = callsTo("/api/platform/schools/{schoolId}/ai-revenue-share/payouts")[0]!;
    expect(init.body).toEqual({
      currencyCode: "USD",
      amountMinor: 36_400,
      reference: "FT-OUT-9",
      paidOn: "2026-11-15",
      note: null,
    });
  });

  test("nothing due: no payout form; upload consistency per teacher", async () => {
    await renderPage();
    expect(await screen.findByText("Nothing is due to be paid out.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Record payout" })).toBeNull();
    const teachers = await screen.findByTestId("upload-teachers");
    expect(
      within(teachers).getByText("Karim Benali").closest("tr")!.getAttribute("data-below"),
    ).toBe("true");
  });
});
