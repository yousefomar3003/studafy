import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import { AuthProvider, createSessionStore } from "../../../lib/auth";
import { expectNoA11yViolations } from "../../../lib/test/axe";

import type { SessionTokens } from "../../../lib/auth";
import type { ComponentType } from "react";

/** Automated accessibility audit for the report center, mirroring `payments/a11y.test.tsx`. */

const AR_AGING_REPORT = {
  report_name: "Accounts Receivable Summary",
  columns: [
    { fieldname: "party_name", fieldtype: "Data", label: "Customer" },
    { fieldname: "range1", fieldtype: "Currency", label: "0-30" },
  ],
  rows: [{ party_name: "Haddad Family", range1: 120 }],
  report_summary: [{ label: "Total Outstanding", value: 120 }],
  presentation: {
    locale: "en",
    direction: "ltr",
    currency: "JOD",
    currency_precision: 3,
    currency_display: [{ range1: "120.000" }],
  },
};

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

const getMock = mock((path: string) => {
  if (path === "/api/finance/reports/ar-aging") return Promise.resolve({ data: AR_AGING_REPORT });
  if (path === "/api/finance/reports/export/{jobId}") {
    return Promise.resolve({ data: { ...QUEUED_JOB, status: "processing" } });
  }
  return Promise.resolve({ data: undefined });
});
const postMock = mock((path: string) => {
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

async function renderInPortal(Page: ComponentType) {
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
            <main>
              <Page />
            </main>
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
});

describe("report center accessibility", () => {
  test("report center, idle before the first run", async () => {
    const { container } = await renderInPortal(await loadPage());
    await screen.findByRole("heading", { name: "Reports" });

    await expectNoA11yViolations(container);
  });

  test("aging report run, populated with rows and a summary", async () => {
    const { container } = await renderInPortal(await loadPage());
    fireEvent.click(screen.getByRole("button", { name: "Run report" }));
    await screen.findByText("Haddad Family");

    await expectNoA11yViolations(container);
  });

  test("export queued, in-flight status pill shown", async () => {
    const { container } = await renderInPortal(await loadPage());
    fireEvent.click(screen.getByRole("button", { name: "Run report" }));
    await screen.findByText("Haddad Family");

    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    await screen.findByText("Processing");

    await expectNoA11yViolations(container);
  });

  test("family statement tab, no family picked yet", async () => {
    const { container } = await renderInPortal(await loadPage());
    fireEvent.click(screen.getByRole("tab", { name: "Family statement" }));
    await screen.findByText("Pick a family and run the report to see its statement.");

    await expectNoA11yViolations(container);
  });
});
