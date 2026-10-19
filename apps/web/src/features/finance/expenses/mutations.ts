import { useMutation } from "@tanstack/react-query";

import { api } from "../../../lib/api";

import type { CreateExpenseBody, Expense, UploadUrlBody, UploadUrlResponse } from "./queries";

/**
 * Requests a pre-signed S3 PUT URL for a new expense attachment. The caller uploads the file's
 * bytes directly to `upload_url` (see `uploadFileToPresignedUrl`), then passes the returned
 * `storage_key` as `attachment_storage_key` on `useCreateExpense` — this app never proxies the
 * file bytes through its own API, only this request/response pair.
 */
export function useRequestExpenseUploadUrl() {
  return useMutation({
    mutationFn: async (body: UploadUrlBody) => {
      const { data } = await api.POST("/api/finance/expenses/upload-url", { body });
      if (!data) throw new Error("Upload URL request returned no data.");
      return data as UploadUrlResponse;
    },
  });
}

export { uploadFileToPresignedUrl } from "../../../lib/upload";

/** `POST /api/finance/expenses` — shared by the entry form and `ExpenseListPage`'s CSV import. */
export async function createExpense(body: CreateExpenseBody): Promise<Expense> {
  const { data } = await api.POST("/api/finance/expenses", { body });
  if (!data) throw new Error("Expense creation returned no data.");
  return data as Expense;
}

export function useCreateExpense() {
  return useMutation({ mutationFn: createExpense });
}
