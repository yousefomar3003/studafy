import { api } from "../../lib/api";

import type { components } from "@studafy/api-client";

export type SubjectRecords = components["schemas"]["SubjectRecords"];
export type RecordEntry = components["schemas"]["RecordEntry"];
export type RecordFieldDefinition = components["schemas"]["RecordFieldDefinition"];
export type RecordForm = components["schemas"]["RecordForm"];
export type RecordDocument = NonNullable<components["schemas"]["RecordDocument"]>;
export type RecordValue = components["schemas"]["RecordValue"];
export type RecordAnswerInput = components["schemas"]["RecordAnswerInput"];
export type RecordSubjectKind = components["schemas"]["RecordSubjectKind"];

/** Whose record: a student (by student id) or a parent (by their user id). */
export interface RecordSubject {
  kind: RecordSubjectKind;
  id: string;
}

export function recordsQueryKey(subject: RecordSubject) {
  return ["records", subject.kind, subject.id] as const;
}

export function recordFormQueryKey(kind: RecordSubjectKind) {
  return ["records", "form", kind] as const;
}

// The generated `readonly` arrays lose their array prototype through `api.GET`'s response typing
// (the same gap `admin/students/queries.ts` documents), so results are restated as plain types.

export async function fetchSubjectRecords(subject: RecordSubject): Promise<SubjectRecords> {
  const { data } =
    subject.kind === "student"
      ? await api.GET("/api/students/{studentId}/records", {
          params: { path: { studentId: subject.id } },
        })
      : await api.GET("/api/parents/{parentUserId}/records", {
          params: { path: { parentUserId: subject.id } },
        });
  if (!data) throw new Error("Record not found.");
  return data as SubjectRecords;
}

export async function fetchRecordForm(kind: RecordSubjectKind): Promise<RecordForm> {
  const { data } = await api.GET("/api/record-forms/{subjectKind}", {
    params: { path: { subjectKind: kind } },
  });
  if (!data) throw new Error("Record form not found.");
  return data as RecordForm;
}

/**
 * The full value of one sensitive answer. Deliberately not a query: the result must never enter
 * the React Query cache (or any other store), only the revealing component's own state.
 */
export async function revealRecordValue(
  subject: RecordSubject,
  fieldId: string,
): Promise<RecordValue> {
  const { data } =
    subject.kind === "student"
      ? await api.POST("/api/students/{studentId}/records/{fieldId}/reveal", {
          params: { path: { studentId: subject.id, fieldId } },
        })
      : await api.POST("/api/parents/{parentUserId}/records/{fieldId}/reveal", {
          params: { path: { parentUserId: subject.id, fieldId } },
        });
  return (data?.value ?? null) as RecordValue;
}

/** A short-lived download URL for a document field's file; never cached either. */
export async function recordDocumentDownloadUrl(
  subject: RecordSubject,
  fieldId: string,
): Promise<string> {
  const { data } =
    subject.kind === "student"
      ? await api.GET("/api/students/{studentId}/records/{fieldId}/document/download", {
          params: { path: { studentId: subject.id, fieldId } },
        })
      : await api.GET("/api/parents/{parentUserId}/records/{fieldId}/document/download", {
          params: { path: { parentUserId: subject.id, fieldId } },
        });
  if (!data) throw new Error("Download URL missing.");
  return data.url;
}

/** Just enough of the parent's account to name them in a page header. */
export interface ParentIdentity {
  display_name: string | null;
  email: string | null;
}

export function parentIdentityQueryKey(userId: string) {
  return ["records", "parent", userId, "identity"] as const;
}

/** The parent's name for a records page header (`user:read`, held by ORG_ADMIN and PRINCIPAL). */
export async function fetchParentIdentity(userId: string): Promise<ParentIdentity> {
  const { data } = await api.GET("/api/users/{userId}", { params: { path: { userId } } });
  if (!data) throw new Error("Parent not found.");
  return { display_name: data.display_name, email: data.email };
}
