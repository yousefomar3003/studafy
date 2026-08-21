import { useMutation } from "@tanstack/react-query";

import { api } from "../../../lib/api";

import type { Award, CreateAwardBody, InitiateRefundBody, Refund } from "./queries";

// ---------------------------------------------------------------------------
// Scholarship/discount awards
// ---------------------------------------------------------------------------

/** Maker step: creates a pending award. */
export function useCreateAward() {
  return useMutation({
    mutationFn: async (body: CreateAwardBody) => {
      const { data } = await api.POST("/api/finance/scholarship-discounts/awards", { body });
      if (!data) throw new Error("Award creation returned no data.");
      return data as Award;
    },
  });
}

/** Checker step: confirms a pending award and forwards it to ERPNext. */
export function useConfirmAward() {
  return useMutation({
    mutationFn: async (awardId: string) => {
      const { data } = await api.POST(
        "/api/finance/scholarship-discounts/awards/{awardId}/confirm",
        { params: { path: { awardId } } },
      );
      if (!data) throw new Error("Award confirmation returned no data.");
      return data as Award;
    },
  });
}

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

export interface InitiateRefundInput {
  body: InitiateRefundBody;
  /** Caller-supplied `Idempotency-Key`, same lifetime rules as `payments/mutations.ts`'s
   * `CreatePaymentInput.idempotencyKey`: one key per submission *attempt*, regenerated only when a
   * fresh form mounts. */
  idempotencyKey: string;
}

/** Maker step: creates a pending refund request. */
export function useInitiateRefund() {
  return useMutation({
    mutationFn: async ({ body, idempotencyKey }: InitiateRefundInput) => {
      const { data } = await api.POST("/api/finance/refunds/initiate", {
        params: { header: { "idempotency-key": idempotencyKey } },
        body,
      });
      if (!data) throw new Error("Refund initiation returned no data.");
      return data as Refund;
    },
  });
}

/** Checker step: approves a pending refund and forwards it to ERPNext as a credit note. */
export function useApproveRefund() {
  return useMutation({
    mutationFn: async (refundId: string) => {
      const { data } = await api.POST("/api/finance/refunds/{refundId}/approve", {
        params: { path: { refundId } },
        body: {},
      });
      if (!data) throw new Error("Refund approval returned no data.");
      return data as Refund;
    },
  });
}

export interface RejectRefundInput {
  refundId: string;
  reasonNotes: string;
}

/** Checker step: rejects a pending refund with mandatory notes. */
export function useRejectRefund() {
  return useMutation({
    mutationFn: async ({ refundId, reasonNotes }: RejectRefundInput) => {
      const { data } = await api.POST("/api/finance/refunds/{refundId}/reject", {
        params: { path: { refundId } },
        body: { reason_notes: reasonNotes },
      });
      if (!data) throw new Error("Refund rejection returned no data.");
      return data as Refund;
    },
  });
}
