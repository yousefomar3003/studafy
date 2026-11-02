import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "../../lib/api";
import { uploadFileToPresignedUrl } from "../../lib/upload";

import { SCHOOL_LICENSE_KEY } from "./queries";

import type { LicenseAudience } from "./queries";
import type { components } from "@studafy/api-client";

/**
 * Writes for the school's license pages. Each one refreshes everything under
 * {@link SCHOOL_LICENSE_KEY}: a seat moves the counts, the people list and the banners; accepting a
 * quote changes the license, the quotes and the invoices.
 */

type Schemas = components["schemas"];
export type AssignResult = Schemas["AssignLicenseSeatsResult"];
export type SeatScope = Schemas["LicenseSeatScope"];

function useLicenseMutation<Input, Output>(mutationFn: (input: Input) => Promise<Output>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: SCHOOL_LICENSE_KEY }),
  });
}

function required<T>(data: T | undefined, what: string): T {
  if (data === undefined) throw new Error(`${what} returned no data.`);
  return data;
}

/** Seats for named people, or for everyone eligible in a scope, filled until the seats run out. */
export function useAssignSeats() {
  return useLicenseMutation(
    async (
      input:
        | { audience: LicenseAudience; userIds: string[] }
        | { audience: LicenseAudience; scope: SeatScope },
    ) => {
      const { data } = await api.POST("/api/school/license/seats", { body: input });
      return required(data, "Seat assignment") as AssignResult;
    },
  );
}

/** Free one or more seats, one request each (the route frees one seat). */
export function useUnassignSeats() {
  return useLicenseMutation(async (seatIds: string[]) => {
    for (const seatId of seatIds) {
      const { data } = await api.DELETE("/api/school/license/seats/{seatId}", {
        params: { path: { seatId } },
      });
      required(data, "Unassign");
    }
    return seatIds.length;
  });
}

export function useRequestChange() {
  return useLicenseMutation(async (body: Schemas["CreateLicenseChangeRequestBody"]) => {
    const { data } = await api.POST("/api/school/license/change-requests", { body });
    return required(data, "Change request");
  });
}

export function useAcceptQuote() {
  return useLicenseMutation(async (quoteId: string) => {
    const { data } = await api.POST("/api/school/license/quotes/{quoteId}/accept", {
      params: { path: { quoteId } },
    });
    return required(data, "Accept") as Schemas["LicenseQuoteAcceptance"];
  });
}

/**
 * A transfer receipt: the file goes to storage through a pre-signed URL (content class
 * `license.receipt`: PDF, JPEG or PNG up to 10 MiB), then its key is attached to the invoice, where
 * it waits as "pending" until Studafy matches it to the payment.
 */
export function useUploadReceipt() {
  return useLicenseMutation(
    async (input: { invoiceId: string; file: File; note: string | null }) => {
      const { data: target } = await api.POST("/api/storage/uploads/request-upload", {
        body: {
          content_class: "license.receipt",
          file_name: input.file.name,
          content_type: input.file.type,
          size_bytes: input.file.size,
        },
      });
      const upload = required(target, "Upload URL");
      await uploadFileToPresignedUrl(upload.upload_url, input.file);
      const { data } = await api.POST("/api/school/license/invoices/{invoiceId}/receipts", {
        params: { path: { invoiceId: input.invoiceId } },
        body: { storageKey: upload.storage_key, note: input.note },
      });
      return required(data, "Receipt");
    },
  );
}

/** A short-lived download URL for one of the school's receipts. */
export async function receiptFileUrl(receiptId: string): Promise<string> {
  const { data } = await api.GET("/api/school/license/receipts/{receiptId}/file", {
    params: { path: { receiptId } },
  });
  return required(data, "Receipt file").url;
}
