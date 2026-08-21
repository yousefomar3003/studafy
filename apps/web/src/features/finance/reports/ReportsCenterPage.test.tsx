import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import { AuthProvider, createSessionStore } from "../../../lib/auth";

import type { SessionTokens } from "../../../lib/auth";
import type { ComponentType } from "react";

const AR_AGING_REPORT = {
  report_name: "Accounts Receivable Summary",
  columns: [
    { fieldname: "party_name", fieldtype: "Data", label: "Customer" },
    { fieldname: "range1", fieldtype: "Currency", label: "0-30" },
  ],
  rows: [{ party_name: "Haddad Family", range1: 120 }],
  report_summary: [],
  presentation: {
    locale: "en",
    direction: "ltr",
    currency: "JOD",
    currency_precision: 3,
    currency_display: [{ range1: "120.000" }],
  },
};

const EMPTY_AR_AGING_REPORT = { ...AR_AGING_REPORT, rows: [], report_summary: [] };

const QUEUED_JOB = {
  id: "job-1",
  report_type: "ar_aging",
  file_format: "csv",
  status: "queued",
  polling_url: "/api/finance/reports/export/job-1",
  download_url: null,
  download_url_expires_at: null,
  failure_message: null,
  created_at: "2026-08-21T00:00:00.000Z",
  started_at: null,
  completed_at: null,
};

// The export panel's first poll already sees the job completed — this test covers the
// queue -> ready transition and its toast/download link, not the 2s polling interval itself, same
// shortcut `RecordPaymentPage.test.tsx` takes for its own confirmation poll.
const COMPLETED_JOB = {
  ...QUEUED_JOB,
  status: "completed",
  download_url: "https://storage.example.com/reports/job-1.csv",
  download_url_expires_at: "2026-08-22T00:00:00.000Z",
  completed_at: "2026-08-21T00:00:05.000Z",
};

let arAgingReport: unknown = AR_AGING_REPORT;

const getMock = mock((path: string) => {
  if (path === "/api/finance/reports/ar-aging") return Promise.resolve({ data: arAgingReport });
  if (path === "/api/finance/reports/export/{jobId}") {
    return Promise.resolve({ data: COMPLETED_JOB });
  }
  return Promise.resolve({ data: undefined });
});

const postMock = mock((path: string, _init?: { body: Record<string, unknown> }) => {
  if (path === "/api/finance/reports/export") return Promise.resolve({ data: QUEUED_JOB });
  return Promise.resolve({ data: undefined });
});

mock.module("../../../lib/api", () => ({ api: { GET: getMock, POST: postMock } }));

const loadPage = async (): Promise<ComponentType> => (await import("./ReportsCenterPage")).default;

function fakeJwt(payload: unknown): string {
  const segment = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${segment({ alg: "RS256" })}.${segment(payload)}.signature`;
}

/** `ORG_ADMIN` holds both `report:viewFinancial` (the route gate) and `report:export` (what
 * `ExportPanel` itself checks before rendering its download controls) — same role
 * `RefundsListPage.test.tsx` renders as for the same reason. */
async function renderPage(Page: ComponentType) {
  const store = createSessionStore({
    refreshClient: {
      refresh: async (): Promise<SessionTokens> => ({
        accessToken: fakeJwt({ roles: ["ORG_ADMIN"], sub: "user-current" }),
        expiresAt: Date.now() + 3_600_000,
        sessionId: "session-1",
      }),
      logout: async () => undefined,
    },
  });
  await store.restore();

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <AuthProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <MemoryRouter>
            <Page />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>
    </AuthProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
  postMock.mockClear();
  arAgingReport = AR_AGING_REPORT;
});

describe("ReportsCenterPage", () => {
  test("shows an idle prompt before the first run", async () => {
    await renderPage(await loadPage());

    expect(
      screen.getByText("Set filters (optional) and run the report to see aging balances."),
    ).toBeTruthy();
  });

  test("running the aging report with zero matching rows shows the empty-data state", async () => {
    arAgingReport = EMPTY_AR_AGING_REPORT;
    await renderPage(await loadPage());

    fireEvent.click(screen.getByRole("button", { name: "Run report" }));

    expect(await screen.findByText("No records match these filters.")).toBeTruthy();
  });

  test("running the aging report shows its rows, then exporting notifies when the file is ready", async () => {
    await renderPage(await loadPage());

    fireEvent.click(screen.getByRole("button", { name: "Run report" }));

    await screen.findByText("Haddad Family");
    expect(screen.getByText("120.000")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));

    // Awaiting the ready toast first guarantees the whole queue -> poll -> complete chain has run
    // before inspecting the request `mutate()` sent — asserting on `postMock` synchronously right
    // after the click would race the mutation's own microtask, the same reason
    // `RecordPaymentPage.test.tsx` only inspects its own `postMock.mock.calls` after awaiting the
    // success state, never immediately after `fireEvent.click`.
    expect(await screen.findByText("Report ready")).toBeTruthy();

    expect(postMock).toHaveBeenCalledTimes(1);
    const [, init] = postMock.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(init.body).toEqual({
      report_type: "ar_aging",
      file_format: "csv",
      parameters: { report_date: undefined, student_ids: undefined },
    });

    const downloadLink = await screen.findByRole("link", {
      name: "Download Accounts receivable aging",
    });
    expect(downloadLink.getAttribute("href")).toBe("https://storage.example.com/reports/job-1.csv");
  });

  test("switching tabs runs a different report independently", async () => {
    await renderPage(await loadPage());

    fireEvent.click(screen.getByRole("tab", { name: "Family statement" }));

    expect(screen.getByText("Pick a family and run the report to see its statement.")).toBeTruthy();
    // The family statement tab has no usable "Run report" until a family is picked.
    const runButton = screen.getByRole("button", { name: "Run report" }) as HTMLButtonElement;
    expect(runButton.disabled).toBe(true);
  });
});
