import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "../../../lib/api";

import { LICENSING_KEY } from "./queries";

import type {
  BankDetails,
  ConsoleFeature,
  ConsoleTier,
  FeatureStatus,
  LicenseAudience,
  LicenseStatus,
  Quote,
  QuoteCalculateBody,
} from "./queries";
import type { components } from "@studafy/api-client";

/**
 * Writes for the license console. Each one refreshes everything under {@link LICENSING_KEY}: the
 * console's figures depend on each other (a payment moves the invoice, the license, the totals and
 * the school's overview), and the console is small enough that a full refresh is cheap.
 */

type Schemas = components["schemas"];

function useLicensingMutation<Input, Output>(mutationFn: (input: Input) => Promise<Output>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: LICENSING_KEY }),
  });
}

function required<T>(data: T | undefined, what: string): T {
  if (data === undefined) throw new Error(`${what} returned no data.`);
  return data;
}

export function useUpdateFeature() {
  return useLicensingMutation(
    async (input: { key: ConsoleFeature["key"]; displayName?: string; status?: FeatureStatus }) => {
      const { key, ...body } = input;
      const { data } = await api.PATCH("/api/platform/features/{featureKey}", {
        params: { path: { featureKey: key } },
        body,
      });
      return required(data, "Feature update") as ConsoleFeature;
    },
  );
}

export type TierBody = Schemas["ConsoleUpdateTierBody"];

export function useSaveTier() {
  return useLicensingMutation(
    async (
      input:
        | { planId: string; body: TierBody }
        | { planId: null; body: TierBody & { code: string; audience: LicenseAudience } },
    ) => {
      if (input.planId === null) {
        const { data } = await api.POST("/api/platform/tiers", { body: input.body });
        return required(data, "Tier create") as ConsoleTier;
      }
      const { data } = await api.PUT("/api/platform/tiers/{planId}", {
        params: { path: { planId: input.planId } },
        body: input.body,
      });
      return required(data, "Tier update") as ConsoleTier;
    },
  );
}

export function useSavePriceSettings() {
  return useLicensingMutation(
    async (input: { currencyCode: string; body: Schemas["LicensePriceSettingsBody"] }) => {
      const { data } = await api.PUT("/api/platform/licenses/price-settings/{currencyCode}", {
        params: { path: { currencyCode: input.currencyCode } },
        body: input.body,
      });
      return required(data, "Price settings");
    },
  );
}

export function useSaveBankDetails() {
  return useLicensingMutation(async (body: BankDetails) => {
    const { data } = await api.PUT("/api/platform/licenses/bank-details", { body });
    return required(data, "Bank details");
  });
}

export function useCreateQuote() {
  return useLicensingMutation(
    async (input: { schoolId: string; body: QuoteCalculateBody & { notes?: string | null } }) => {
      const { schoolId: _ignored, ...body } = input.body;
      const { data } = await api.POST("/api/platform/schools/{schoolId}/license-quotes", {
        params: { path: { schoolId: input.schoolId } },
        body,
      });
      return required(data, "Quote") as Quote;
    },
  );
}

export type QuoteAction = "send" | "accept" | "withdraw";

export function useQuoteAction() {
  return useLicensingMutation(
    async (input: { schoolId: string; quoteId: string; action: QuoteAction }) => {
      const params = { path: { schoolId: input.schoolId, quoteId: input.quoteId } };
      if (input.action === "send") {
        const { data } = await api.POST(
          "/api/platform/schools/{schoolId}/license-quotes/{quoteId}/send",
          { params },
        );
        return required(data, "Send");
      }
      if (input.action === "accept") {
        const { data } = await api.POST(
          "/api/platform/schools/{schoolId}/license-quotes/{quoteId}/accept",
          { params },
        );
        return required(data, "Accept");
      }
      const { data } = await api.POST(
        "/api/platform/schools/{schoolId}/license-quotes/{quoteId}/withdraw",
        { params },
      );
      return required(data, "Withdraw");
    },
  );
}

export function useLicenseStatus() {
  return useLicensingMutation(
    async (input: { schoolId: string; licenseId: string; status: LicenseStatus }) => {
      const { data } = await api.POST(
        "/api/platform/schools/{schoolId}/licenses/{licenseId}/status",
        {
          params: { path: { schoolId: input.schoolId, licenseId: input.licenseId } },
          body: { status: input.status as Schemas["SchoolLicenseStatusBody"]["status"] },
        },
      );
      return required(data, "Status change");
    },
  );
}

export function useExtendLicense() {
  return useLicensingMutation(
    async (input: { schoolId: string; licenseId: string; endsAt: string }) => {
      const { data } = await api.POST(
        "/api/platform/schools/{schoolId}/licenses/{licenseId}/extend",
        {
          params: { path: { schoolId: input.schoolId, licenseId: input.licenseId } },
          body: { endsAt: input.endsAt },
        },
      );
      return required(data, "Extension");
    },
  );
}

export function useActivateEarly() {
  return useLicensingMutation(
    async (input: { schoolId: string; invoiceId: string; dueDate: string }) => {
      const { data } = await api.POST(
        "/api/platform/schools/{schoolId}/license-invoices/{invoiceId}/activate-early",
        {
          params: { path: { schoolId: input.schoolId, invoiceId: input.invoiceId } },
          body: { dueDate: input.dueDate },
        },
      );
      return required(data, "Early activation");
    },
  );
}

export function useAssignSeats() {
  return useLicensingMutation(
    async (input: {
      schoolId: string;
      licenseId: string;
      body: Schemas["AssignLicenseSeatsBody"];
    }) => {
      const { data } = await api.POST(
        "/api/platform/schools/{schoolId}/licenses/{licenseId}/seats",
        {
          params: { path: { schoolId: input.schoolId, licenseId: input.licenseId } },
          body: input.body,
        },
      );
      return required(data, "Seat assignment");
    },
  );
}

export function useUnassignSeat() {
  return useLicensingMutation(
    async (input: { schoolId: string; licenseId: string; seatId: string }) => {
      const { data } = await api.DELETE(
        "/api/platform/schools/{schoolId}/licenses/{licenseId}/seats/{seatId}",
        { params: { path: input } },
      );
      return required(data, "Unassign");
    },
  );
}

export function useResolveChangeRequest() {
  return useLicensingMutation(
    async (input: {
      schoolId: string;
      requestId: string;
      status: "resolved" | "declined";
      note: string | null;
    }) => {
      const { data } = await api.POST(
        "/api/platform/schools/{schoolId}/license-requests/{requestId}/resolve",
        {
          params: { path: { schoolId: input.schoolId, requestId: input.requestId } },
          body: { status: input.status, note: input.note },
        },
      );
      return required(data, "Change request");
    },
  );
}

/**
 * Upload a receipt file to the school's storage through the console's upload URL, and hand back
 * the temp key the payment then promotes.
 */
async function uploadReceipt(schoolId: string, file: File): Promise<string> {
  const { data } = await api.POST("/api/platform/schools/{schoolId}/license-payments/upload-url", {
    params: { path: { schoolId } },
    body: { fileName: file.name, contentType: file.type, sizeBytes: file.size },
  });
  const target = required(data, "Upload URL");
  const response = await fetch(target.uploadUrl, {
    method: "PUT",
    body: file,
    headers: { "content-type": file.type },
  });
  if (!response.ok) throw new Error(`Receipt upload failed (${response.status}).`);
  return target.storageKey;
}

export function useRecordPayment() {
  return useLicensingMutation(
    async (input: {
      schoolId: string;
      invoiceId: string;
      amountMinor: number;
      receivedAt: string;
      bankReference: string;
      note: string | null;
      receiptId: string | null;
      file: File | null;
    }) => {
      const receiptStorageKey = input.file ? await uploadReceipt(input.schoolId, input.file) : null;
      const { data } = await api.POST(
        "/api/platform/schools/{schoolId}/license-invoices/{invoiceId}/payments",
        {
          params: { path: { schoolId: input.schoolId, invoiceId: input.invoiceId } },
          body: {
            amountMinor: input.amountMinor,
            receivedAt: input.receivedAt,
            bankReference: input.bankReference,
            note: input.note,
            receiptId: input.receiptId,
            receiptStorageKey,
          },
        },
      );
      return required(data, "Payment");
    },
  );
}

export function useVoidPayment() {
  return useLicensingMutation(
    async (input: { schoolId: string; paymentId: string; reason: string }) => {
      const { data } = await api.POST(
        "/api/platform/schools/{schoolId}/license-payments/{paymentId}/void",
        {
          params: { path: { schoolId: input.schoolId, paymentId: input.paymentId } },
          body: { reason: input.reason },
        },
      );
      return required(data, "Void");
    },
  );
}

export function useVoidInvoice() {
  return useLicensingMutation(
    async (input: { schoolId: string; invoiceId: string; reason: string }) => {
      const { data } = await api.POST(
        "/api/platform/schools/{schoolId}/license-invoices/{invoiceId}/void",
        {
          params: { path: { schoolId: input.schoolId, invoiceId: input.invoiceId } },
          body: { reason: input.reason },
        },
      );
      return required(data, "Void");
    },
  );
}

export function useMatchReceipt() {
  return useLicensingMutation(
    async (input: { schoolId: string; receiptId: string; paymentId: string }) => {
      const { data } = await api.POST(
        "/api/platform/schools/{schoolId}/license-receipts/{receiptId}/match",
        {
          params: { path: { schoolId: input.schoolId, receiptId: input.receiptId } },
          body: { paymentId: input.paymentId },
        },
      );
      return required(data, "Receipt match");
    },
  );
}

/** A short-lived download URL for a school's receipt or a payment's file. */
export async function fileUrl(
  input: { schoolId: string; receiptId: string } | { schoolId: string; paymentId: string },
): Promise<string> {
  if ("receiptId" in input) {
    const { data } = await api.GET(
      "/api/platform/schools/{schoolId}/license-receipts/{receiptId}/file",
      { params: { path: input } },
    );
    return required(data, "Receipt file").url;
  }
  const { data } = await api.GET(
    "/api/platform/schools/{schoolId}/license-payments/{paymentId}/receipt-file",
    { params: { path: input } },
  );
  return required(data, "Payment file").url;
}
