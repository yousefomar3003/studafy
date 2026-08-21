import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import type { ComponentType } from "react";

const STUDENT = {
  id: "student-1",
  first_name: "Layla",
  last_name: "Haddad",
  admission_number: "ADM-001",
};

const DISCOUNT = {
  id: "discount-1",
  school_id: "school-1",
  erpnext_docname: "SD-0001",
  erpnext_status: "Active",
  title: "Sibling discount",
  discount_type: "percentage",
  amount: 15,
  scope: "global",
  fee_category: null,
  currency: null,
  currency_minor_unit: null,
  is_active: true,
  last_synced_at: "2026-08-01T00:00:00.000Z",
};

const CREATED_AWARD = {
  id: "award-1",
  school_id: "school-1",
  student_id: "student-1",
  scholarship_discount_id: "discount-1",
  scholarship_discount_title: "Sibling discount",
  award_status: "pending",
  awarded_by: "user-1",
  confirmed_by: null,
  confirmed_at: null,
  erpnext_docname: null,
  created_at: "2026-08-21T00:00:00.000Z",
  updated_at: "2026-08-21T00:00:00.000Z",
};

const getMock = mock((path: string) => {
  if (path === "/api/students") {
    return Promise.resolve({ data: { students: [STUDENT], total: 1 } });
  }
  if (path === "/api/finance/scholarship-discounts") {
    return Promise.resolve({ data: { scholarship_discounts: [DISCOUNT], total: 1 } });
  }
  return Promise.resolve({ data: undefined });
});

let createAwardCalls = 0;
const postMock = mock((path: string, _init?: { body: Record<string, unknown> }) => {
  if (path === "/api/finance/scholarship-discounts/awards") {
    createAwardCalls += 1;
    return Promise.resolve({ data: CREATED_AWARD });
  }
  return Promise.resolve({ data: undefined });
});

mock.module("../../../lib/api", () => ({ api: { GET: getMock, POST: postMock } }));

const loadPage = async (): Promise<ComponentType> =>
  (await import("./NewScholarshipAwardPage")).default;

function renderPage(Page: ComponentType) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/portal/finance/adjustments/scholarships/new"]}>
          <Page />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
  postMock.mockClear();
  createAwardCalls = 0;
});

describe("NewScholarshipAwardPage", () => {
  test("picks a student and discount, shows the computed effect, and creates a pending award", async () => {
    renderPage(await loadPage());

    fireEvent.change(screen.getByLabelText("Student", { exact: false }), {
      target: { value: "Layla" },
    });
    fireEvent.click(await screen.findByRole("button", { name: /Layla Haddad/ }));

    fireEvent.click(await screen.findByRole("combobox", { name: "Scholarship / discount" }));
    fireEvent.click(screen.getByRole("option", { name: "Sibling discount" }));

    await screen.findByText("15% off all fee categories on every future invoice.");

    fireEvent.click(screen.getByRole("button", { name: "Review award" }));

    // The confirmation dialog shows the exact computed effect before it commits.
    const dialog = await screen.findByRole("dialog", { name: "Award scholarship?" });
    expect(dialog.textContent).toContain("Sibling discount");
    expect(dialog.textContent).toContain("15% off all fee categories on every future invoice.");

    fireEvent.click(screen.getByRole("button", { name: "Create award" }));

    expect(await screen.findByText("Award created — Sibling discount")).toBeTruthy();
    expect(createAwardCalls).toBe(1);

    const [, init] = postMock.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(init.body).toEqual({
      student_id: "student-1",
      scholarship_discount_id: "discount-1",
    });
  });
});
