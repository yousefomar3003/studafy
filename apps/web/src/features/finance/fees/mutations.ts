import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "../../../lib/api";

import type { CreateFeeStructureBody, FeeStructure, UpdateFeeStructureBody } from "./queries";

/** Invalidates every cached academic-year filter of the list, not just one — a structure without an
 * `academic_year_id` shows up under the "all years" key, and one with an id shows up under both that
 * key and its own, so a single-key invalidation would leave a stale list somewhere. */
function invalidateFeeStructureLists(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: ["finance", "fee-structures"] });
}

export function useCreateFeeStructure() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (body: CreateFeeStructureBody) => {
      const { data } = await api.POST("/api/finance/fee-structures", { body });
      if (!data) throw new Error("Fee structure creation returned no data.");
      return data as FeeStructure;
    },
    onSuccess: () => invalidateFeeStructureLists(queryClient),
  });
}

export interface UpdateFeeStructureVariables {
  feeStructureId: string;
  body: UpdateFeeStructureBody;
}

export function useUpdateFeeStructure() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ feeStructureId, body }: UpdateFeeStructureVariables) => {
      const { data } = await api.PATCH("/api/finance/fee-structures/{feeStructureId}", {
        params: { path: { feeStructureId } },
        body,
      });
      if (!data) throw new Error("Fee structure update returned no data.");
      return data as FeeStructure;
    },
    onSuccess: () => invalidateFeeStructureLists(queryClient),
  });
}
