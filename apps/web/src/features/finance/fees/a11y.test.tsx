import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import { expectNoA11yViolations } from "../../../lib/test/axe";

import type { ComponentType } from "react";

/** Automated accessibility audit for the fee structure builder, mirroring `finance/a11y.test.tsx`. */

const YEAR = {
  id: "year-1",
  school_id: "school-1",
  code: "2025-2026",
  name: "2025-2026",
  starts_on: "2025-09-01",
  ends_on: "2026-06-30",
  status: "active" as const,
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z",
};

const STRUCTURE = {
  erpnext_name: "FS-2026-0001",
  school_id: "school-1",
  academic_year_id: "year-1",
  program: "Grade 5",
  title: "Grade 5 Fees",
  total_amount: "1000.000",
  total_amount_minor: 1000000,
  currency: "JOD",
  currency_minor_unit: 3,
  erpnext_status: "draft",
  is_active: true,
  last_synced_at: "2026-08-01T00:00:00.000Z",
};

const getMock = mock((path: string) => {
  if (path === "/api/academics/years") {
    return Promise.resolve({ data: { academic_years: [YEAR], total: 1 } });
  }
  if (path === "/api/finance/fee-structures") {
    return Promise.resolve({ data: { fee_structures: [STRUCTURE], total: 1 } });
  }
  if (path === "/api/finance/scholarship-discounts") {
    return Promise.resolve({ data: { scholarship_discounts: [], total: 0 } });
  }
  return Promise.resolve({ data: undefined });
});
mock.module("../../../lib/api", () => ({ api: { GET: getMock } }));

const loadPage = async (): Promise<ComponentType> =>
  (await import("./FeeStructureBuilderPage")).default;

function renderInPortal(Page: ComponentType) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter>
          <main>
            <Page />
          </main>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
});

describe("fee structure builder accessibility", () => {
  test("list populated, new-structure form", async () => {
    const { container } = renderInPortal(await loadPage());
    await screen.findByRole("heading", { name: "Fee structures" });
    await screen.findByText("Grade 5 Fees", { selector: "button" });

    await expectNoA11yViolations(container);
  });
});
