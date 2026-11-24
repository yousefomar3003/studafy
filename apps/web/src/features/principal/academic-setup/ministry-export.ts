import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../../../lib/api";
import { fetchRecordForm } from "../../records/queries";

import type { components } from "@studafy/api-client";

type Schemas = components["schemas"];

export type MinistryExportTemplate = Schemas["MinistryExportTemplate"];
export type MinistryExportTemplateBody = Schemas["MinistryExportTemplateInput"];
export type MinistryExportExample = Schemas["MinistryExportExample"];
export type MinistryExportField = Schemas["MinistryExportField"];
export type MinistryExportRowKind = Schemas["MinistryExportRowKind"];
export type MinistryExportFileFormat = Schemas["MinistryExportFileFormat"];
export type MinistryExportEncoding = Schemas["MinistryExportEncoding"];
export type MinistryExportRunBody = Schemas["MinistryExportRunInput"];
export type MinistryExportPreview = Schemas["MinistryExportPreview"];
export type MinistryExportIssue = Schemas["MinistryExportIssue"];

/**
 * Ministry results export: the school's export templates (not tied to an academic year) and
 * running one over a year's finalized results. Leadership only. Previews are fetched on demand and
 * never cached; a download is a file, saved straight away.
 */
export const MINISTRY_EXPORT_KEY = ["ministry-export"] as const;

const keys = {
  templates: [...MINISTRY_EXPORT_KEY, "templates"] as const,
  examples: [...MINISTRY_EXPORT_KEY, "examples"] as const,
  nationalIdFields: [...MINISTRY_EXPORT_KEY, "national-id-fields"] as const,
};

/** The response body re-typed as its schema (see `required` in queries.ts for why). */
function required<T>(data: unknown, what: string): T {
  if (data === undefined || data === null) throw new Error(`${what} returned no data.`);
  return data as T;
}

export function useMinistryExportTemplates(enabled = true) {
  return useQuery({
    queryKey: keys.templates,
    enabled,
    queryFn: async () => {
      const { data } = await api.GET("/api/grading/ministry-export-templates");
      return required<Schemas["MinistryExportTemplateList"]>(data, "Ministry export templates")
        .templates;
    },
  });
}

export function useMinistryExportExamples(enabled = true) {
  return useQuery({
    queryKey: keys.examples,
    enabled,
    staleTime: Infinity,
    queryFn: async () => {
      const { data } = await api.GET("/api/grading/ministry-export-examples");
      return required<Schemas["MinistryExportExampleList"]>(data, "Ministry export examples")
        .examples;
    },
  });
}

/** The student record fields a national ID can be kept in: short text or number, not archived. */
export function useNationalIdFields(enabled = true) {
  return useQuery({
    queryKey: keys.nationalIdFields,
    enabled,
    queryFn: async () =>
      (await fetchRecordForm("student")).fields.filter(
        (field) => field.field_type === "short_text" || field.field_type === "number",
      ),
  });
}

export function useSaveMinistryExportTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      templateId,
      body,
    }: {
      templateId: string | null;
      body: MinistryExportTemplateBody;
    }) => {
      if (templateId) {
        const { data } = await api.PUT("/api/grading/ministry-export-templates/{templateId}", {
          params: { path: { templateId } },
          body,
        });
        return required<MinistryExportTemplate>(data, "Ministry export template");
      }
      const { data } = await api.POST("/api/grading/ministry-export-templates", { body });
      return required<MinistryExportTemplate>(data, "Ministry export template");
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.templates }),
  });
}

export function useDeleteMinistryExportTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (templateId: string) => {
      await api.DELETE("/api/grading/ministry-export-templates/{templateId}", {
        params: { path: { templateId } },
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.templates }),
  });
}

export function usePreviewMinistryExport() {
  return useMutation({
    mutationFn: async (body: MinistryExportRunBody) => {
      const { data } = await api.POST("/api/grading/ministry-exports/preview", { body });
      return required<MinistryExportPreview>(data, "Ministry export preview");
    },
  });
}

/** The file name the API gave the download, or a plain one for the format. */
export function downloadFileName(disposition: string | null, format: MinistryExportFileFormat) {
  const match = disposition ? /filename="([^"]+)"/.exec(disposition) : null;
  return match?.[1] ?? `ministry-export.${format}`;
}

/** The whole file, fetched with the session's token (a plain link could not carry it). */
export async function fetchMinistryExportFile(
  body: MinistryExportRunBody,
  format: MinistryExportFileFormat,
): Promise<{ blob: Blob; fileName: string }> {
  const { data, response } = await api.POST("/api/grading/ministry-exports/download", {
    body,
    parseAs: "blob",
  });
  if (!data) throw new Error("Export unavailable");
  return {
    blob: data as unknown as Blob,
    fileName: downloadFileName(response?.headers.get("Content-Disposition") ?? null, format),
  };
}
