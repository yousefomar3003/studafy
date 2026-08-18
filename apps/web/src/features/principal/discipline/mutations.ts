import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "../../../lib/api";

import { DISCIPLINE_KEY_ROOT } from "./queries";

import type { DisciplineAction, DisciplineIncident, DisciplineIncidentStatus } from "./queries";
import type { components } from "@studafy/api-client";

export type CreateActionInput = components["schemas"]["CreateActionBody"];
export type ResolveIncidentInput = components["schemas"]["ResolveIncidentBody"];

/** A workflow-button transition target — every status except "resolved", which goes through the
 * dedicated resolve endpoint (`useResolveIncident`) instead of a plain status PATCH. */
export type IncidentTransitionStatus = Exclude<DisciplineIncidentStatus, "resolved">;

/**
 * Every mutation below invalidates the whole `discipline-incidents` prefix, the same coarse choice
 * `approvals/mutations.ts` makes for `["approval-queue"]`: the dashboard tile, the incident list
 * (including the teacher-reported inbox), and this incident's own detail/actions queries all key off
 * this root, and a single status or action change can move counts in all of them at once.
 */
function useInvalidateDiscipline() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: DISCIPLINE_KEY_ROOT });
}

/** Records a disciplinary action against an incident. Resolving an incident requires at least one
 * of these to exist (enforced client-side on the detail screen — see `IncidentDetailPage.tsx`). */
export function useCreateAction(incidentId: string) {
  const invalidate = useInvalidateDiscipline();

  return useMutation({
    mutationFn: async (input: CreateActionInput): Promise<DisciplineAction> => {
      const { data } = await api.POST("/api/discipline/incidents/{incidentId}/actions", {
        params: { path: { incidentId } },
        body: input,
      });
      if (!data) throw new Error("Discipline action creation returned no data.");
      return data;
    },
    onSuccess: async () => {
      await invalidate();
    },
  });
}

/** Moves an incident to "under_review", "escalated", or "closed". The server re-validates the
 * transition against the same state machine `INCIDENT_STATUS_TRANSITIONS` mirrors, so a stale UI
 * (e.g. another admin already closed it) still fails safely with a 409. */
export function useUpdateIncidentStatus(incidentId: string) {
  const invalidate = useInvalidateDiscipline();

  return useMutation({
    mutationFn: async (status: IncidentTransitionStatus): Promise<DisciplineIncident> => {
      const { data } = await api.PATCH("/api/discipline/incidents/{incidentId}", {
        params: { path: { incidentId } },
        body: { status },
      });
      if (!data) throw new Error("Discipline incident update returned no data.");
      return data;
    },
    onSuccess: async () => {
      await invalidate();
    },
  });
}

export function useResolveIncident(incidentId: string) {
  const invalidate = useInvalidateDiscipline();

  return useMutation({
    mutationFn: async (input: ResolveIncidentInput): Promise<DisciplineIncident> => {
      const { data } = await api.POST("/api/discipline/incidents/{incidentId}/resolve", {
        params: { path: { incidentId } },
        body: input,
      });
      if (!data) throw new Error("Discipline incident resolution returned no data.");
      return data;
    },
    onSuccess: async () => {
      await invalidate();
    },
  });
}
