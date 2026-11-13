import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "../../../../lib/api";

import { IMPORT_HISTORY_KEY, IMPORT_SETTINGS_KEY, importColumnsKey } from "./queries";

import type {
  ImportColumnApplyResult,
  ImportColumnPreview,
  ImportColumnTarget,
  ImportSettings,
} from "./queries";

/** A one-minute signed URL for the original file; every one issued is audited server-side. */
export function useDownloadImportSource() {
  return useMutation({
    mutationFn: async (importId: string) => {
      const { data } = await api.GET("/api/imports/students/{importId}/source", {
        params: { path: { importId } },
      });
      if (!data) throw new Error("Download URL missing.");
      return data.url;
    },
  });
}

export function useDeleteImportSource() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (importId: string) => {
      await api.DELETE("/api/imports/students/{importId}/source", {
        params: { path: { importId } },
      });
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: IMPORT_HISTORY_KEY }),
  });
}

/** What a column would write. Writes nothing; the preview's token is what the apply sends back. */
export function usePreviewImportColumn(importId: string) {
  return useMutation({
    mutationFn: async (target: ImportColumnTarget) => {
      const { data } = await api.POST("/api/imports/students/{importId}/columns/preview", {
        params: { path: { importId } },
        body: target,
      });
      if (!data) throw new Error("Column preview returned no data.");
      return data as ImportColumnPreview;
    },
  });
}

export function useApplyImportColumn(importId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ImportColumnTarget & { preview_token: string }) => {
      const { data } = await api.POST("/api/imports/students/{importId}/columns/apply", {
        params: { path: { importId } },
        body: input,
      });
      if (!data) throw new Error("Column apply returned no data.");
      return data as ImportColumnApplyResult;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: importColumnsKey(importId) });
      void queryClient.invalidateQueries({ queryKey: IMPORT_HISTORY_KEY });
    },
  });
}

export function useUpdateImportSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (sourceRetentionDays: number) => {
      const { data } = await api.PUT("/api/imports/students/settings", {
        body: { source_retention_days: sourceRetentionDays },
      });
      if (!data) throw new Error("Import settings returned no data.");
      return data as ImportSettings;
    },
    onSuccess: (settings) => {
      queryClient.setQueryData(IMPORT_SETTINGS_KEY, settings);
      // Expiry dates on every listed file move with the period.
      void queryClient.invalidateQueries({ queryKey: IMPORT_HISTORY_KEY });
    },
  });
}
