import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "../../../lib/api";

import { STUDENTS_LIST_KEY, studentGuardiansQueryKey, studentQueryKey } from "./queries";

import type { GuardianContact, StudentProfile } from "./queries";
import type { CreateStudentValues, LinkGuardianValues } from "./schema";
import type { components } from "@studafy/api-client";
import type { QueryClient, QueryKey } from "@tanstack/react-query";

interface StudentsListResult {
  students: StudentProfile[];
  next_cursor: string | null;
}

type Snapshot = [QueryKey, StudentsListResult | undefined][];

/**
 * Optimistic-update plumbing shared by the list-affecting mutations below, mirroring the users
 * feature's `snapshotUserLists`/`restoreUserLists`/`patchUserInLists` (see `admin/users/mutations.ts`)
 * — a student can appear on any cached filter/cursor combination, so these operate on every query
 * keyed under `STUDENTS_LIST_KEY` at once, not just the page on screen.
 */
function snapshotStudentLists(queryClient: QueryClient): Snapshot {
  return queryClient.getQueriesData<StudentsListResult>({ queryKey: STUDENTS_LIST_KEY });
}

function restoreStudentLists(queryClient: QueryClient, snapshot: Snapshot): void {
  for (const [key, data] of snapshot) {
    queryClient.setQueryData(key, data);
  }
}

function patchStudentInLists(
  queryClient: QueryClient,
  studentId: string,
  patch: (student: StudentProfile) => StudentProfile,
): void {
  queryClient.setQueriesData<StudentsListResult>({ queryKey: STUDENTS_LIST_KEY }, (data) => {
    if (!data) return data;
    return {
      ...data,
      students: data.students.map((student) =>
        student.id === studentId ? patch(student) : student,
      ),
    };
  });
}

function invalidateStudentLists(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: STUDENTS_LIST_KEY });
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/** A locally-generated id for the optimistic row, replaced by the real one once the server responds
 * (or removed on rollback). Prefixed so it can never collide with a real UUID. */
function tempId(): string {
  return `optimistic-${crypto.randomUUID()}`;
}

export function useCreateStudent() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (values: CreateStudentValues) => {
      const { data } = await api.POST("/api/students", { body: values });
      if (!data) throw new Error("Student creation returned no data.");
      return data as StudentProfile;
    },
    onMutate: async (values) => {
      await queryClient.cancelQueries({ queryKey: STUDENTS_LIST_KEY });
      const snapshot = snapshotStudentLists(queryClient);

      const now = new Date().toISOString();
      // New students sort first (the list orders by created_at DESC, matching the users list), so
      // the optimistic row only belongs on whichever cached page has no cursor — i.e. the first page
      // of each filter set.
      const optimistic: StudentProfile = {
        id: tempId(),
        school_id: "",
        user_id: "",
        first_name: values.first_name,
        middle_name: values.middle_name ?? null,
        last_name: values.last_name,
        preferred_name: values.preferred_name ?? null,
        date_of_birth: values.date_of_birth ?? null,
        nationality_country_id: null,
        admission_number: values.admission_number,
        admission_date: values.admission_date ?? null,
        status: values.status,
        created_at: now,
        updated_at: now,
      };
      queryClient.setQueriesData<StudentsListResult>(
        { queryKey: STUDENTS_LIST_KEY, predicate: (query) => query.queryKey.at(-1) === undefined },
        (data) => (data ? { ...data, students: [optimistic, ...data.students] } : data),
      );

      return { snapshot };
    },
    onError: (_error, _values, context) => {
      if (context) restoreStudentLists(queryClient, context.snapshot);
    },
    onSettled: () => invalidateStudentLists(queryClient),
  });
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export type UpdateStudentBody = components["schemas"]["UpdateStudentBody"];

export interface UpdateStudentVariables {
  studentId: string;
  patch: UpdateStudentBody;
}

/** Backs both the demographics form and the (separately permission-gated) admission-fields form on
 * the profile page — both send a partial `UpdateStudentBody` through the same endpoint. */
export function useUpdateStudent() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ studentId, patch }: UpdateStudentVariables) => {
      const { data } = await api.PATCH("/api/students/{studentId}", {
        params: { path: { studentId } },
        body: patch,
      });
      if (!data) throw new Error("Student update returned no data.");
      return data as StudentProfile;
    },
    onMutate: async ({ studentId, patch }) => {
      await queryClient.cancelQueries({ queryKey: STUDENTS_LIST_KEY });
      const snapshot = snapshotStudentLists(queryClient);
      const previousDetail = queryClient.getQueryData<StudentProfile>(studentQueryKey(studentId));

      patchStudentInLists(queryClient, studentId, (student) => ({ ...student, ...patch }));
      if (previousDetail) {
        queryClient.setQueryData(studentQueryKey(studentId), { ...previousDetail, ...patch });
      }

      return { snapshot, previousDetail, studentId };
    },
    onError: (_error, _vars, context) => {
      if (!context) return;
      restoreStudentLists(queryClient, context.snapshot);
      if (context.previousDetail) {
        queryClient.setQueryData(studentQueryKey(context.studentId), context.previousDetail);
      }
    },
    onSettled: (_data, _error, { studentId }) => {
      invalidateStudentLists(queryClient);
      void queryClient.invalidateQueries({ queryKey: studentQueryKey(studentId) });
    },
  });
}

// ---------------------------------------------------------------------------
// Guardian link / unlink
// ---------------------------------------------------------------------------

export interface LinkGuardianVariables extends LinkGuardianValues {
  studentId: string;
}

export function useLinkGuardian() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ studentId, ...body }: LinkGuardianVariables) => {
      const { data } = await api.POST("/api/students/{studentId}/guardians", {
        params: { path: { studentId } },
        body,
      });
      if (!data) throw new Error("Guardian link returned no data.");
      return data;
    },
    onSuccess: (_data, { studentId }) => {
      void queryClient.invalidateQueries({ queryKey: studentGuardiansQueryKey(studentId) });
    },
  });
}

export interface UnlinkGuardianVariables {
  studentId: string;
  userId: string;
}

export function useUnlinkGuardian() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ studentId, userId }: UnlinkGuardianVariables) => {
      await api.DELETE("/api/students/{studentId}/guardians/{userId}", {
        params: { path: { studentId, userId } },
      });
    },
    onMutate: async ({ studentId, userId }) => {
      await queryClient.cancelQueries({ queryKey: studentGuardiansQueryKey(studentId) });
      const previous = queryClient.getQueryData<GuardianContact[]>(
        studentGuardiansQueryKey(studentId),
      );
      queryClient.setQueryData<GuardianContact[]>(studentGuardiansQueryKey(studentId), (data) =>
        data?.filter((guardian) => guardian.parent_user_id !== userId),
      );
      return { previous, studentId };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(studentGuardiansQueryKey(context.studentId), context.previous);
      }
    },
    onSettled: (_data, _error, { studentId }) => {
      void queryClient.invalidateQueries({ queryKey: studentGuardiansQueryKey(studentId) });
    },
  });
}
