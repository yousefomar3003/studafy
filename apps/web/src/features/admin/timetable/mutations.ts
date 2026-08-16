import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "../../../lib/api";

import { slotsQueryKey, versionsQueryKey } from "./queries";

import type { TimetableSlot, TimetableVersion } from "./queries";
import type { components } from "@studafy/api-client";

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

export interface CreateVersionVariables {
  term_id: string;
  academic_year_id: string;
  name: string;
}

export function useCreateVersion() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (values: CreateVersionVariables) => {
      const { data } = await api.POST("/api/academics/timetable-versions", { body: values });
      if (!data) throw new Error("Timetable version creation returned no data.");
      return data as TimetableVersion;
    },
    onSuccess: (version) => {
      void queryClient.invalidateQueries({ queryKey: versionsQueryKey(version.term_id) });
    },
  });
}

export interface DeleteVersionVariables {
  versionId: string;
  termId: string;
}

/** Draft-only, and only when it has no slots — enforced server-side (409 otherwise); this doesn't
 * duplicate that guard client-side, it just surfaces the response. */
export function useDeleteVersion() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ versionId }: DeleteVersionVariables) => {
      await api.DELETE("/api/academics/timetable-versions/{versionId}", {
        params: { path: { versionId } },
      });
    },
    onSuccess: (_data, { termId }) => {
      void queryClient.invalidateQueries({ queryKey: versionsQueryKey(termId) });
    },
  });
}

export interface SubmitVersionVariables {
  versionId: string;
  termId: string;
}

export function useSubmitVersion() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ versionId }: SubmitVersionVariables) => {
      const { data } = await api.POST("/api/academics/timetable-versions/{versionId}/submit", {
        params: { path: { versionId } },
      });
      if (!data) throw new Error("Timetable version submission returned no data.");
      return data as TimetableVersion;
    },
    onSuccess: (_data, { termId }) => {
      void queryClient.invalidateQueries({ queryKey: versionsQueryKey(termId) });
    },
  });
}

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

export type CreateSlotBody = components["schemas"]["CreateTimetableSlotBody"];
export type UpdateSlotBody = components["schemas"]["UpdateTimetableSlotBody"];

export interface CreateSlotVariables {
  versionId: string;
  body: CreateSlotBody;
}

export function useCreateSlot() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ versionId, body }: CreateSlotVariables) => {
      const { data } = await api.POST("/api/academics/timetable-versions/{versionId}/slots", {
        params: { path: { versionId } },
        body,
      });
      if (!data) throw new Error("Slot creation returned no data.");
      return data as TimetableSlot;
    },
    onSuccess: (_data, { versionId }) => {
      void queryClient.invalidateQueries({ queryKey: slotsQueryKey(versionId) });
    },
  });
}

export interface UpdateSlotVariables {
  slotId: string;
  versionId: string;
  body: UpdateSlotBody;
}

export function useUpdateSlot() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ slotId, body }: UpdateSlotVariables) => {
      const { data } = await api.PATCH("/api/academics/slots/{slotId}", {
        params: { path: { slotId } },
        body,
      });
      if (!data) throw new Error("Slot update returned no data.");
      return data as TimetableSlot;
    },
    onSuccess: (_data, { versionId }) => {
      void queryClient.invalidateQueries({ queryKey: slotsQueryKey(versionId) });
    },
  });
}

export interface DeleteSlotVariables {
  slotId: string;
  versionId: string;
}

export function useDeleteSlot() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ slotId }: DeleteSlotVariables) => {
      await api.DELETE("/api/academics/slots/{slotId}", { params: { path: { slotId } } });
    },
    onSuccess: (_data, { versionId }) => {
      void queryClient.invalidateQueries({ queryKey: slotsQueryKey(versionId) });
    },
  });
}
