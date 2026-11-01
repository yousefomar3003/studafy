import { useMutation } from "@tanstack/react-query";

import { api } from "../../../lib/api";

import type {
  CreateExpenseBody,
  Expense,
  UpdateExpenseBody,
  UploadUrlBody,
  UploadUrlResponse,
} from "./queries";

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

/** `PATCH /api/finance/expenses/{expenseId}` — forwarded to ERPNext, which may refuse a submitted
 * document; the detail page only offers it on a draft. */
export function useUpdateExpense(expenseId: string) {
  return useMutation({
    mutationFn: async (body: UpdateExpenseBody) => {
      const { data } = await api.PATCH("/api/finance/expenses/{expenseId}", {
        params: { path: { expenseId } },
        body,
      });
      if (!data) throw new Error("Expense update returned no data.");
      return data as Expense;
    },
  });
}

/** Links a receipt uploaded after the expense was recorded: upload-url, PUT, then this confirm. */
export function useConfirmExpenseAttachment(expenseId: string) {
  return useMutation({
    mutationFn: async (storageKey: string) => {
      const { data } = await api.POST("/api/finance/expenses/{expenseId}/attachments", {
        params: { path: { expenseId } },
        body: { storage_key: storageKey },
      });
      if (!data) throw new Error("Attachment confirmation returned no data.");
      return data as Expense;
    },
  });
}
