import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import type { ComponentType } from "react";

const FEE_STRUCTURE = {
  erpnext_name: "FS-2026-0001",
  school_id: "school-1",
  academic_year_id: "year-1",
  program: "Grade 5",
  title: "Grade 5 Fees",
  total_amount: "1000.000",
  total_amount_minor: 1000000,
  currency: "JOD",
  currency_minor_unit: 3,
  erpnext_status: "submitted",
  is_active: true,
  last_synced_at: "2026-08-01T00:00:00.000Z",
};

const CREATED_BATCH = {
  id: "batch-1",
  school_id: "school-1",
  created_by: "user-1",
  status: "pending",
  fee_structure_erpnext_name: "FS-2026-0001",
  period_title: "Spring 2026 Term 1",
  due_date: null,
  target_class_ids: null,
  total_count: 2,
  succeeded_count: 0,
  already_existed_count: 0,
  failed_count: 0,
  created_at: "2026-08-19T00:00:00.000Z",
  updated_at: "2026-08-19T00:00:00.000Z",
  completed_at: null,
};

const COMPLETED_BATCH = {
  ...CREATED_BATCH,
  status: "completed",
  succeeded_count: 2,
  completed_at: "2026-08-19T00:01:00.000Z",
};

const ITEMS_RESPONSE = {
  items: [
    {
      id: "item-1",
      batch_id: "batch-1",
      student_id: "student-1",
      student_name: "Layla Haddad",
      admission_number: "ADM-001",
      status: "succeeded",
      erpnext_docname: "ACC-SINV-2026-00001",
      error_message: null,
      created_at: "2026-08-19T00:00:30.000Z",
      updated_at: "2026-08-19T00:00:30.000Z",
    },
  ],
  next_cursor: null,
};

const getMock = mock((path: string) => {
  if (path === "/api/finance/fee-structures") {
    return Promise.resolve({ data: { fee_structures: [FEE_STRUCTURE], total: 1 } });
  }
  if (path === "/api/academics/classes") {
    return Promise.resolve({ data: { classes: [], total: 0 } });
  }
  // The progress panel's first poll already sees the batch completed — this test covers the
  // form -> progress state transition and the terminal-state rendering, not the 3s polling
  // interval itself.
  if (path === "/api/finance/invoices/batches/{batchId}") {
    return Promise.resolve({ data: COMPLETED_BATCH });
  }
  if (path === "/api/finance/invoices/batches/{batchId}/items") {
    return Promise.resolve({ data: ITEMS_RESPONSE });
  }
  return Promise.resolve({ data: undefined });
});

const postMock = mock((path: string, _init?: { body: Record<string, unknown> }) => {
  if (path === "/api/finance/invoices/batches") {
    return Promise.resolve({ data: CREATED_BATCH });
  }
  return Promise.resolve({ data: undefined });
});

mock.module("../../../lib/api", () => ({ api: { GET: getMock, POST: postMock } }));

const loadPage = async (): Promise<ComponentType> => (await import("./InvoiceBatchPage")).default;

function renderPage(Page: ComponentType) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter>
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
});

describe("InvoiceBatchPage", () => {
  test("submitting the form starts a batch and shows its completed progress", async () => {
    renderPage(await loadPage());

    await screen.findByText("Grade 5 Fees (1000.000 JOD)");

    fireEvent.click(screen.getByRole("combobox", { name: "Fee structure" }));
    fireEvent.click(screen.getByRole("option", { name: "Grade 5 Fees (1000.000 JOD)" }));

    fireEvent.change(screen.getByLabelText("Period title"), {
      target: { value: "Spring 2026 Term 1" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Start batch" }));

    expect(await screen.findByText(/Completed — Spring 2026 Term 1/)).toBeTruthy();
    expect(postMock).toHaveBeenCalledTimes(1);
    const [, init] = postMock.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(init.body).toEqual({
      fee_structure_erpnext_name: "FS-2026-0001",
      period_title: "Spring 2026 Term 1",
      due_date: undefined,
      target_class_ids: undefined,
    });

    // Terminal-state summary and per-row results.
    const totalStat = screen.getByText("Total").closest("div") as HTMLElement;
    expect(within(totalStat).getByText("2")).toBeTruthy();
    await screen.findByText("Layla Haddad");
    await screen.findByText("ACC-SINV-2026-00001");
    expect(screen.getByRole("button", { name: "Start another batch" })).toBeTruthy();
  });
});
