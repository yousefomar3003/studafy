import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "../../../lib/api";

import { SCHOOL_SETTINGS_KEY } from "./queries";

import type { SchoolSettings } from "./queries";
import type { components } from "@studafy/api-client";

export type UpdateSchoolSettingsBody = components["schemas"]["UpdateSchoolSettings"];

/**
 * `PATCH /api/schools/current/settings` — callers pass only the fields their section owns; the
 * server `COALESCE`s everything else to its current value (see `service.ts`), so a section never
 * has to know the current value of a field it doesn't render. The response is the full row, written
 * straight into the cache — every section reads from the same `SCHOOL_SETTINGS_KEY`, so one save
 * updates what every other section displays without a refetch.
 */
export function useUpdateSchoolSettings() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (patch: UpdateSchoolSettingsBody) => {
      const { data } = await api.PATCH("/api/schools/current/settings", { body: patch });
      if (!data) throw new Error("School settings update returned no data.");
      return data as SchoolSettings;
    },
    onSuccess: (settings) => {
      queryClient.setQueryData(SCHOOL_SETTINGS_KEY, settings);
    },
  });
}
