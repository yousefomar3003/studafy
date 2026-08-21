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

/**
 * PUTs `file`'s bytes directly to a pre-signed S3 URL obtained from `useRequestExpenseUploadUrl`.
 * Not a TanStack mutation, and not routed through `api`: the URL is already fully authorized and
 * points outside this app's own API, so there is no typed client call to wrap here.
 */
export async function uploadFileToPresignedUrl(uploadUrl: string, file: File): Promise<void> {
  const response = await fetch(uploadUrl, {
    method: "PUT",
    body: file,
    headers: file.type ? { "Content-Type": file.type } : undefined,
  });
  if (!response.ok) {
    throw new Error(`Attachment upload failed (${response.status}).`);
  }
}

export function useCreateExpense() {
  return useMutation({
    mutationFn: async (body: CreateExpenseBody) => {
      const { data } = await api.POST("/api/finance/expenses", { body });
      if (!data) throw new Error("Expense creation returned no data.");
      return data as Expense;
    },
  });
}
