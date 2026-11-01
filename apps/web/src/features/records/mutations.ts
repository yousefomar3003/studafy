import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "../../lib/api";
import { uploadFileToPresignedUrl } from "../../lib/upload";

import { recordsQueryKey } from "./queries";

import type { RecordAnswerInput, RecordSubject, SubjectRecords } from "./queries";

/**
 * The four subjects' document routes share one request and response shape; the generated client
 * types each path separately, so the call is made through this one signature.
 */
type DocumentWrite = (
  path: string,
  init: { params: { path: Record<string, string> }; body?: unknown },
) => Promise<{ data?: SubjectRecords }>;

function useRecordsMutation<Input>(
  subject: RecordSubject,
  run: (input: Input) => Promise<SubjectRecords | undefined>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: (records) => {
      // Every write answers with the record as it now stands (masked as ever), so the cache is
      // replaced rather than refetched; a delete (no body) refetches instead.
      if (records) queryClient.setQueryData(recordsQueryKey(subject), records);
      else void queryClient.invalidateQueries({ queryKey: recordsQueryKey(subject) });
    },
  });
}

async function putRecords(subject: RecordSubject, body: { answers: RecordAnswerInput[] }) {
  switch (subject.kind) {
    case "student":
      return api.PUT("/api/students/{studentId}/records", {
        params: { path: { studentId: subject.id } },
        body,
      });
    case "parent":
      return api.PUT("/api/parents/{parentUserId}/records", {
        params: { path: { parentUserId: subject.id } },
        body,
      });
    case "staff":
      return api.PUT("/api/staff/{staffUserId}/records", {
        params: { path: { staffUserId: subject.id } },
        body,
      });
    case "class":
      return api.PUT("/api/classes/{classId}/records", {
        params: { path: { classId: subject.id } },
        body,
      });
  }
}

/** `PUT …/records`: the changed answers only; `null` clears one. */
export function useSaveRecordAnswers(subject: RecordSubject) {
  return useRecordsMutation(subject, async (answers: RecordAnswerInput[]) => {
    const { data } = await putRecords(subject, { answers });
    return data as SubjectRecords | undefined;
  });
}

/**
 * The content class a document field's file is staged under (the API's content-classes.ts): each
 * subject's pairs that subject's edit permission, and a class field is never sensitive.
 */
export function documentContentClass(subject: RecordSubject, sensitive: boolean) {
  if (subject.kind === "staff") {
    return sensitive ? "staffRecord.sensitiveDocument" : "staffRecord.document";
  }
  if (subject.kind === "class") return "classRecord.document";
  return sensitive ? "record.sensitiveDocument" : "record.document";
}

interface DocumentPath {
  fieldId: string;
}

function documentCall(
  subject: RecordSubject,
  { fieldId }: DocumentPath,
): { path: string; params: { path: Record<string, string> } } {
  switch (subject.kind) {
    case "student":
      return {
        path: "/api/students/{studentId}/records/{fieldId}/document",
        params: { path: { studentId: subject.id, fieldId } },
      };
    case "parent":
      return {
        path: "/api/parents/{parentUserId}/records/{fieldId}/document",
        params: { path: { parentUserId: subject.id, fieldId } },
      };
    case "staff":
      return {
        path: "/api/staff/{staffUserId}/records/{fieldId}/document",
        params: { path: { staffUserId: subject.id, fieldId } },
      };
    case "class":
      return {
        path: "/api/classes/{classId}/records/{fieldId}/document",
        params: { path: { classId: subject.id, fieldId } },
      };
  }
}

export interface AttachDocumentInput {
  fieldId: string;
  file: File;
  sensitive: boolean;
  expiresOn: string | null;
}

/**
 * A document field's file: staged through the storage gateway under the field's content class
 * (`record.sensitiveDocument` for a sensitive field, which the API enforces again on attach),
 * PUT to the pre-signed URL, then attached — the attach confirms and promotes it.
 */
export function useAttachRecordDocument(subject: RecordSubject) {
  return useRecordsMutation(subject, async (input: AttachDocumentInput) => {
    const { data: target } = await api.POST("/api/storage/uploads/request-upload", {
      body: {
        content_class: documentContentClass(subject, input.sensitive),
        file_name: input.file.name,
        content_type: input.file.type,
        size_bytes: input.file.size,
      },
    });
    if (!target) throw new Error("Upload URL missing.");
    await uploadFileToPresignedUrl(target.upload_url, input.file);
    const body = {
      storage_key: target.storage_key,
      ...(input.expiresOn ? { expires_on: input.expiresOn } : {}),
    };
    const call = documentCall(subject, input);
    const { data } = await (api.PUT as unknown as DocumentWrite)(call.path, {
      params: call.params,
      body,
    });
    return data;
  });
}

export interface UpdateDocumentInput {
  fieldId: string;
  status?: "uploaded" | "verified";
  expiresOn?: string | null;
}

/** Verify a document, withdraw a verification, or set its expiry date. */
export function useUpdateRecordDocument(subject: RecordSubject) {
  return useRecordsMutation(subject, async (input: UpdateDocumentInput) => {
    const body = {
      ...(input.status ? { status: input.status } : {}),
      ...(input.expiresOn !== undefined ? { expires_on: input.expiresOn } : {}),
    };
    const call = documentCall(subject, input);
    const { data } = await (api.PATCH as unknown as DocumentWrite)(call.path, {
      params: call.params,
      body,
    });
    return data;
  });
}

export function useRemoveRecordDocument(subject: RecordSubject) {
  return useRecordsMutation(subject, async (fieldId: string) => {
    const call = documentCall(subject, { fieldId });
    await (api.DELETE as unknown as DocumentWrite)(call.path, { params: call.params });
    return undefined;
  });
}
