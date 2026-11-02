import { cleanup, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";

import { renderFinance } from "../test-utils";

const BATCH = {
  id: "batch-1",
  school_id: "school-1",
  created_by: "user-1",
  status: "completed",
  fee_structure_erpnext_name: "FS-2026-0001",
  period_title: "Term 1",
  due_date: null,
  target_class_ids: null,
  total_count: 30,
  succeeded_count: 28,
  already_existed_count: 0,
  failed_count: 2,
  created_at: "2026-09-01T08:00:00.000Z",
  updated_at: "2026-09-01T08:05:00.000Z",
  completed_at: "2026-09-01T08:05:00.000Z",
};

const getMock = mock((path: string, _init?: unknown) =>
  Promise.resolve({
    data:
      path === "/api/finance/invoices/batches"
        ? { invoice_batches: [BATCH], next_cursor: null }
        : undefined,
  }),
);

mock.module("../../../lib/api", () => ({ api: { GET: getMock, POST: mock() } }));

afterEach(() => {
  cleanup();
  getMock.mockClear();
});

describe("InvoiceBatchHistoryPage", () => {
  test("lists past runs with their results, each opening its own page", async () => {
    const Page = (await import("./InvoiceBatchHistoryPage")).default;
    await renderFinance(<Page />);

    expect(await screen.findByText("Term 1")).toBeTruthy();
    expect(screen.getByText("28 of 30 billed · 2 failed")).toBeTruthy();
    const link = screen
      .getAllByRole("link")
      .find((a) => a.getAttribute("href")?.endsWith("/batch-1"));
    expect(link?.getAttribute("href")).toBe("/portal/finance/invoices/batches/batch-1");
  });
});
