import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "../../../lib/api";

import { slotsQueryKey, TIMETABLE_SETTINGS_KEY, versionsQueryKey } from "./queries";

import type { TimetableSettings, TimetableSlot, TimetableVersion } from "./queries";
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

export interface VersionTransitionVariables {
  versionId: string;
  termId: string;
}

/** Draft → live in one step (`POST …/publish`): submit and approve in a single transaction. */
export function usePublishVersion() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ versionId }: VersionTransitionVariables) => {
      const { data } = await api.POST("/api/academics/timetable-versions/{versionId}/publish", {
        params: { path: { versionId } },
      });
      if (!data) throw new Error("Timetable publish returned no data.");
      return data as TimetableVersion;
    },
    onSuccess: (_data, { termId }) => {
      void queryClient.invalidateQueries({ queryKey: versionsQueryKey(termId) });
    },
  });
}

/** Approves a version someone submitted through the two-step review flow. */
export function useApproveVersion() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ versionId }: VersionTransitionVariables) => {
      const { data } = await api.POST("/api/academics/timetable-versions/{versionId}/approve", {
        params: { path: { versionId } },
      });
      if (!data) throw new Error("Timetable approval returned no data.");
      return data as TimetableVersion;
    },
    onSuccess: (_data, { termId }) => {
      void queryClient.invalidateQueries({ queryKey: versionsQueryKey(termId) });
    },
  });
}

/** Sends a submitted version back to draft so it can be edited again. */
export function useReturnToDraft() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ versionId }: VersionTransitionVariables) => {
      const { data } = await api.POST("/api/academics/timetable-versions/{versionId}/reject", {
        params: { path: { versionId } },
        body: {},
      });
      if (!data) throw new Error("Timetable rejection returned no data.");
      return data as TimetableVersion;
    },
    onSuccess: (_data, { termId }) => {
      void queryClient.invalidateQueries({ queryKey: versionsQueryKey(termId) });
    },
  });
}

/** Throws away an unpublished draft, slots included (`?discard_slots=true`). */
export function useDiscardDraft() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ versionId }: VersionTransitionVariables) => {
      await api.DELETE("/api/academics/timetable-versions/{versionId}", {
        params: { path: { versionId }, query: { discard_slots: "true" } },
      });
    },
    onSuccess: (_data, { termId }) => {
      void queryClient.invalidateQueries({ queryKey: versionsQueryKey(termId) });
    },
  });
}

export interface StartEditingVariables {
  termId: string;
  academicYearId: string;
  name: string;
  /** The live version to copy; omitted when the term has no timetable yet (starts empty). */
  sourceVersionId?: string;
}

/** Opens a draft to edit: a copy of the live timetable, or an empty one for a term without any. */
export function useStartEditing() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      termId,
      academicYearId,
      name,
      sourceVersionId,
    }: StartEditingVariables) => {
      if (sourceVersionId) {
        const { data } = await api.POST("/api/academics/timetable-versions/copy", {
          body: {
            source_version_id: sourceVersionId,
            term_id: termId,
            academic_year_id: academicYearId,
            name,
          },
        });
        if (!data) throw new Error("Timetable copy returned no data.");
        return data.timetable_version as TimetableVersion;
      }
      const { data } = await api.POST("/api/academics/timetable-versions", {
        body: { term_id: termId, academic_year_id: academicYearId, name },
      });
      if (!data) throw new Error("Timetable version creation returned no data.");
      return data as TimetableVersion;
    },
    onSuccess: (_data, { termId }) => {
      void queryClient.invalidateQueries({ queryKey: versionsQueryKey(termId) });
    },
  });
}

// ---------------------------------------------------------------------------
// School week
// ---------------------------------------------------------------------------

export function useUpdateTimetableSettings() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (body: TimetableSettings) => {
      const { data } = await api.PUT("/api/academics/timetable-settings", { body });
      if (!data) throw new Error("Timetable settings update returned no data.");
      return data as TimetableSettings;
    },
    onSuccess: (settings) => {
      queryClient.setQueryData(TIMETABLE_SETTINGS_KEY, settings);
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
