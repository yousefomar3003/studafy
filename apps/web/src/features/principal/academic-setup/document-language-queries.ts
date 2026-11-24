import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../../../lib/api";

import { GRADING_KEY } from "./queries";

import type { components } from "@studafy/api-client";

export type DocumentLanguageSettings = components["schemas"]["DocumentLanguageSettings"];
export type UpdateDocumentLanguageSettingsBody =
  components["schemas"]["UpdateDocumentLanguageSettingsBody"];
export type DocumentLanguageSetting = DocumentLanguageSettings["certificate_language"];

export const DOCUMENT_LANGUAGE_SETTINGS: readonly DocumentLanguageSetting[] = [
  "viewer",
  "en",
  "ar",
  "bilingual",
];

const documentLanguageKey = () => [...GRADING_KEY, "document-language-settings"] as const;

/** The language each document type is issued in, and the school's Arabic name (000263). */
export function useDocumentLanguageSettings() {
  return useQuery({
    queryKey: documentLanguageKey(),
    queryFn: async () => {
      const { data } = await api.GET("/api/grading/document-language-settings");
      if (!data) throw new Error("Document language settings returned no data.");
      return data;
    },
  });
}

export function useUpdateDocumentLanguageSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: UpdateDocumentLanguageSettingsBody) => {
      const { data } = await api.PUT("/api/grading/document-language-settings", { body });
      if (!data) throw new Error("Document language settings returned no data.");
      return data;
    },
    onSuccess: (data) => queryClient.setQueryData(documentLanguageKey(), data),
  });
}
