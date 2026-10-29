import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "../../../lib/api";

import { recordTemplateKey } from "./queries";

import type { RecordSubjectKind, RecordTemplate, RecordTemplateField } from "./queries";
import type { components } from "@studafy/api-client";

export type CreateRecordFieldBody = components["schemas"]["CreateRecordFieldBody"];
export type UpdateRecordFieldBody = components["schemas"]["UpdateRecordFieldBody"];

/** Every edit is a draft: refetch the template so `has_unpublished_changes` stays the server's. */
function useInvalidateTemplate(kind: RecordSubjectKind) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: recordTemplateKey(kind) });
}

/** `POST /api/record-templates/{kind}/fields` — adds a draft field at the end of the form. */
export function useCreateRecordField(kind: RecordSubjectKind) {
  const invalidate = useInvalidateTemplate(kind);
  return useMutation({
    mutationFn: async (body: CreateRecordFieldBody) => {
      const { data } = await api.POST("/api/record-templates/{subjectKind}/fields", {
        params: { path: { subjectKind: kind } },
        body,
      });
      if (!data) throw new Error("Field create returned no data.");
      return data as RecordTemplateField;
    },
    onSettled: invalidate,
  });
}

/** `PATCH .../fields/{fieldId}` — edits a draft field, or archives / restores it. */
export function useUpdateRecordField(kind: RecordSubjectKind) {
  const invalidate = useInvalidateTemplate(kind);
  return useMutation({
    mutationFn: async ({ fieldId, body }: { fieldId: string; body: UpdateRecordFieldBody }) => {
      const { data } = await api.PATCH("/api/record-templates/{subjectKind}/fields/{fieldId}", {
        params: { path: { subjectKind: kind, fieldId } },
        body,
      });
      if (!data) throw new Error("Field update returned no data.");
      return data as RecordTemplateField;
    },
    onSettled: invalidate,
  });
}

/** `PUT .../field-order` — the draft order; the response is the whole template. */
export function useReorderRecordFields(kind: RecordSubjectKind) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (fieldIds: string[]) => {
      const { data } = await api.PUT("/api/record-templates/{subjectKind}/field-order", {
        params: { path: { subjectKind: kind } },
        body: { field_ids: fieldIds },
      });
      if (!data) throw new Error("Field reorder returned no data.");
      return data as RecordTemplate;
    },
    onSuccess: (template) => queryClient.setQueryData(recordTemplateKey(kind), template),
  });
}

/** `POST .../publish` — snapshots the draft as the next version. */
export function usePublishRecordTemplate(kind: RecordSubjectKind) {
  const invalidate = useInvalidateTemplate(kind);
  return useMutation({
    mutationFn: async () => {
      const { data } = await api.POST("/api/record-templates/{subjectKind}/publish", {
        params: { path: { subjectKind: kind } },
      });
      if (!data) throw new Error("Publish returned no data.");
      return data;
    },
    onSettled: invalidate,
  });
}
