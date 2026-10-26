import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "../../../lib/api";
import {
  APPROVED_TIMETABLE_KEY_ROOT,
  CLASSES_KEY_ROOT,
  COURSES_KEY,
  ENROLLMENT_COUNTS_KEY_ROOT,
  SUBJECTS_KEY,
} from "../school/queries";

import type { Class } from "../../admin/timetable/queries";
import type { Course, Subject } from "../school/queries";
import type { components } from "@studafy/api-client";
import type { QueryClient, QueryKey } from "@tanstack/react-query";

export type CreateClassInput = components["schemas"]["CreateClassBody"];
export type UpdateClassInput = components["schemas"]["UpdateClassBody"];
export type CreateSubjectInput = components["schemas"]["CreateSubjectBody"];
export type CreateCourseInput = components["schemas"]["CreateCourseBody"];

/**
 * Everything keyed on classes: the principal's per-term lists, the timetable builder's class
 * palette, a section's class list, and every timetable slot (which carries its class's code and
 * section). Moving a class into a section enrols that section's students, so enrolment counts move too.
 */
const CLASS_KEY_ROOTS: readonly QueryKey[] = [
  CLASSES_KEY_ROOT,
  ["timetable", "classes"],
  ["sections", "classes"],
  ["timetable", "slots"],
  APPROVED_TIMETABLE_KEY_ROOT,
  ENROLLMENT_COUNTS_KEY_ROOT,
];

function invalidateClasses(queryClient: QueryClient) {
  return Promise.all(
    CLASS_KEY_ROOTS.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
  );
}

// ---------------------------------------------------------------------------
// Classes
// ---------------------------------------------------------------------------

/** 409 on a code already used in the school; 404 when the section isn't in the class's year. */
export function useCreateClass() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateClassInput): Promise<Class> => {
      const { data } = await api.POST("/api/academics/classes", { body });
      if (!data) throw new Error("Class creation returned no data.");
      return data as Class;
    },
    onSuccess: () => invalidateClasses(queryClient),
  });
}

/** Course, year and term are fixed once a class exists; the body carries only what changed. */
export function useUpdateClass() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      classId,
      body,
    }: {
      classId: string;
      body: UpdateClassInput;
    }): Promise<Class> => {
      const { data } = await api.PATCH("/api/academics/classes/{classId}", {
        params: { path: { classId } },
        body,
      });
      if (!data) throw new Error("Class update returned no data.");
      return data as Class;
    },
    onSuccess: () => invalidateClasses(queryClient),
  });
}

/** Hard-deletes a class without enrolments; one with enrolments is cancelled instead. */
export function useDeleteClass() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (classId: string): Promise<void> => {
      await api.DELETE("/api/academics/classes/{classId}", { params: { path: { classId } } });
    },
    onSuccess: () => invalidateClasses(queryClient),
  });
}

// ---------------------------------------------------------------------------
// Course catalog
// ---------------------------------------------------------------------------

export function useCreateSubject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateSubjectInput): Promise<Subject> => {
      const { data } = await api.POST("/api/academics/subjects", { body });
      if (!data) throw new Error("Subject creation returned no data.");
      return data as Subject;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: SUBJECTS_KEY }),
  });
}

export function useCreateCourse() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      subjectId,
      body,
    }: {
      subjectId: string;
      body: CreateCourseInput;
    }): Promise<Course> => {
      const { data } = await api.POST("/api/academics/subjects/{subjectId}/courses", {
        params: { path: { subjectId } },
        body,
      });
      if (!data) throw new Error("Course creation returned no data.");
      return data as Course;
    },
    onSuccess: (course) => {
      // Add it to the cached catalog right away so a form can select it before the refetch lands.
      queryClient.setQueryData<Course[]>(COURSES_KEY, (courses) =>
        courses && !courses.some((existing) => existing.id === course.id)
          ? [...courses, course]
          : courses,
      );
      return queryClient.invalidateQueries({ queryKey: COURSES_KEY });
    },
  });
}
