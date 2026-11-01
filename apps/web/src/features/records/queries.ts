import { SCHOOL_STAFF_ROLES } from "@studafy/constants";

import { api } from "../../lib/api";

import type { components } from "@studafy/api-client";
import type { Role } from "@studafy/constants";

export type SubjectRecords = components["schemas"]["SubjectRecords"];
export type RecordEntry = components["schemas"]["RecordEntry"];
export type RecordFieldDefinition = components["schemas"]["RecordFieldDefinition"];
export type RecordForm = components["schemas"]["RecordForm"];
export type RecordDocument = NonNullable<components["schemas"]["RecordDocument"]>;
export type RecordValue = components["schemas"]["RecordValue"];
export type RecordAnswerInput = components["schemas"]["RecordAnswerInput"];
export type RecordSubjectKind = components["schemas"]["RecordSubjectKind"];

/**
 * Whose record: a student (by student id), a parent or a member of staff (by their user id), or a
 * class. `self` is the signed-in member of staff reading their own record (`id` is their user id).
 */
export interface RecordSubject {
  kind: RecordSubjectKind;
  id: string;
  self?: boolean;
}

export function recordsQueryKey(subject: RecordSubject) {
  return ["records", subject.self ? "self" : subject.kind, subject.id] as const;
}

export function recordFormQueryKey(kind: RecordSubjectKind) {
  return ["records", "form", kind] as const;
}

// The generated `readonly` arrays lose their array prototype through `api.GET`'s response typing
// (the same gap `admin/students/queries.ts` documents), so results are restated as plain types.

async function getRecords(subject: RecordSubject) {
  if (subject.self) return api.GET("/api/me/staff-record");
  switch (subject.kind) {
    case "student":
      return api.GET("/api/students/{studentId}/records", {
        params: { path: { studentId: subject.id } },
      });
    case "parent":
      return api.GET("/api/parents/{parentUserId}/records", {
        params: { path: { parentUserId: subject.id } },
      });
    case "staff":
      return api.GET("/api/staff/{staffUserId}/records", {
        params: { path: { staffUserId: subject.id } },
      });
    case "class":
      return api.GET("/api/classes/{classId}/records", {
        params: { path: { classId: subject.id } },
      });
  }
}

export async function fetchSubjectRecords(subject: RecordSubject): Promise<SubjectRecords> {
  const { data } = await getRecords(subject);
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
  // Only leadership reveals, and a class field is never sensitive: there is no class reveal.
  const { data } =
    subject.kind === "student"
      ? await api.POST("/api/students/{studentId}/records/{fieldId}/reveal", {
          params: { path: { studentId: subject.id, fieldId } },
        })
      : subject.kind === "staff"
        ? await api.POST("/api/staff/{staffUserId}/records/{fieldId}/reveal", {
            params: { path: { staffUserId: subject.id, fieldId } },
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
  const { data } = await getDownload(subject, fieldId);
  if (!data) throw new Error("Download URL missing.");
  return data.url;
}

async function getDownload(subject: RecordSubject, fieldId: string) {
  if (subject.self) {
    return api.GET("/api/me/staff-record/{fieldId}/document/download", {
      params: { path: { fieldId } },
    });
  }
  switch (subject.kind) {
    case "student":
      return api.GET("/api/students/{studentId}/records/{fieldId}/document/download", {
        params: { path: { studentId: subject.id, fieldId } },
      });
    case "parent":
      return api.GET("/api/parents/{parentUserId}/records/{fieldId}/document/download", {
        params: { path: { parentUserId: subject.id, fieldId } },
      });
    case "staff":
      return api.GET("/api/staff/{staffUserId}/records/{fieldId}/document/download", {
        params: { path: { staffUserId: subject.id, fieldId } },
      });
    case "class":
      return api.GET("/api/classes/{classId}/records/{fieldId}/document/download", {
        params: { path: { classId: subject.id, fieldId } },
      });
  }
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

export function staffIdentityQueryKey(userId: string) {
  return ["records", "staff", userId, "identity"] as const;
}

/** A member of staff's name, read as a parent's is (`user:read`, ORG_ADMIN and PRINCIPAL). */
export const fetchStaffIdentity = fetchParentIdentity;

export function classIdentityQueryKey(classId: string) {
  return ["records", "class", classId, "identity"] as const;
}

/** A class's code for a records page header. */
export async function fetchClassIdentity(classId: string): Promise<{ code: string }> {
  const { data } = await api.GET("/api/academics/classes/{classId}", {
    params: { path: { classId } },
  });
  if (!data) throw new Error("Class not found.");
  return { code: data.code };
}

/** Whether these session roles make the caller a member of the school's staff (own record). */
export function holdsStaffRole(roles: readonly string[]): boolean {
  return roles.some((role) => SCHOOL_STAFF_ROLES.includes(role as Role));
}
