import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "../../lib/api";
import { uploadFileToPresignedUrl } from "../../lib/upload";

import { recordsQueryKey } from "./queries";

import type { RecordAnswerInput, RecordSubject, SubjectRecords } from "./queries";

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

/** `PUT …/records`: the changed answers only; `null` clears one. */
export function useSaveRecordAnswers(subject: RecordSubject) {
  return useRecordsMutation(subject, async (answers: RecordAnswerInput[]) => {
    const body = { answers };
    const { data } =
      subject.kind === "student"
        ? await api.PUT("/api/students/{studentId}/records", {
            params: { path: { studentId: subject.id } },
            body,
          })
        : await api.PUT("/api/parents/{parentUserId}/records", {
            params: { path: { parentUserId: subject.id } },
            body,
          });
    return data as SubjectRecords | undefined;
  });
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
        content_class: input.sensitive ? "record.sensitiveDocument" : "record.document",
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
    const { data } =
      subject.kind === "student"
        ? await api.PUT("/api/students/{studentId}/records/{fieldId}/document", {
            params: { path: { studentId: subject.id, fieldId: input.fieldId } },
            body,
          })
        : await api.PUT("/api/parents/{parentUserId}/records/{fieldId}/document", {
            params: { path: { parentUserId: subject.id, fieldId: input.fieldId } },
            body,
          });
    return data as SubjectRecords | undefined;
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
    const { data } =
      subject.kind === "student"
        ? await api.PATCH("/api/students/{studentId}/records/{fieldId}/document", {
            params: { path: { studentId: subject.id, fieldId: input.fieldId } },
            body,
          })
        : await api.PATCH("/api/parents/{parentUserId}/records/{fieldId}/document", {
            params: { path: { parentUserId: subject.id, fieldId: input.fieldId } },
            body,
          });
    return data as SubjectRecords | undefined;
  });
}

export function useRemoveRecordDocument(subject: RecordSubject) {
  return useRecordsMutation(subject, async (fieldId: string) => {
    if (subject.kind === "student") {
      await api.DELETE("/api/students/{studentId}/records/{fieldId}/document", {
        params: { path: { studentId: subject.id, fieldId } },
      });
    } else {
      await api.DELETE("/api/parents/{parentUserId}/records/{fieldId}/document", {
        params: { path: { parentUserId: subject.id, fieldId } },
      });
    }
    return undefined;
  });
}
