import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "../../../lib/api";
import { COURSES_KEY, SUBJECTS_KEY } from "../school/queries";

import type { components } from "@studafy/api-client";
import type { QueryClient } from "@tanstack/react-query";

export type UpdateSubjectInput = components["schemas"]["UpdateSubjectBody"];
export type UpdateCourseInput = components["schemas"]["UpdateCourseBody"];

/** Classes and timetable slots show their course's code and name, so a catalog change refreshes
 * them too. */
function invalidateCatalog(queryClient: QueryClient) {
  return Promise.all(
    [SUBJECTS_KEY, COURSES_KEY, ["principal-school", "classes"], ["timetable"]].map((queryKey) =>
      queryClient.invalidateQueries({ queryKey }),
    ),
  );
}

export function useUpdateSubject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ subjectId, body }: { subjectId: string; body: UpdateSubjectInput }) => {
      const { data } = await api.PATCH("/api/academics/subjects/{subjectId}", {
        params: { path: { subjectId } },
        body,
      });
      if (!data) throw new Error("Subject update returned no data.");
      return data;
    },
    onSuccess: () => invalidateCatalog(queryClient),
  });
}

/** Deletes a subject nothing uses yet; one with courses is archived instead (the API decides). */
export function useDeleteSubject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (subjectId: string) => {
      await api.DELETE("/api/academics/subjects/{subjectId}", { params: { path: { subjectId } } });
    },
    onSuccess: () => invalidateCatalog(queryClient),
  });
}

export function useUpdateCourse() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ courseId, body }: { courseId: string; body: UpdateCourseInput }) => {
      const { data } = await api.PATCH("/api/academics/courses/{courseId}", {
        params: { path: { courseId } },
        body,
      });
      if (!data) throw new Error("Course update returned no data.");
      return data;
    },
    onSuccess: () => invalidateCatalog(queryClient),
  });
}

/** Deletes a course no class uses yet; one with classes is archived instead (the API decides). */
export function useDeleteCourse() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (courseId: string) => {
      await api.DELETE("/api/academics/courses/{courseId}", { params: { path: { courseId } } });
    },
    onSuccess: () => invalidateCatalog(queryClient),
  });
}
