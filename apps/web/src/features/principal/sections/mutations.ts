import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "../../../lib/api";
import { GRADE_LEVELS_KEY, SECTIONS_KEY_ROOT } from "../../admin/timetable/queries";
import { APPROVED_TIMETABLE_KEY_ROOT, ENROLLMENT_COUNTS_KEY_ROOT } from "../school/queries";

import { SECTION_STUDENTS_KEY_ROOT } from "./queries";

import type { GradeLevel, Section, SectionPlacementResult } from "./queries";
import type { components } from "@studafy/api-client";
import type { QueryClient, QueryKey } from "@tanstack/react-query";

export type CreateGradeLevelInput = components["schemas"]["CreateGradeLevelBody"];
export type UpdateGradeLevelInput = components["schemas"]["UpdateGradeLevelBody"];
export type CreateSectionInput = components["schemas"]["CreateSectionBody"];

/** Timetable slots carry their section's and grade's names, so renaming either refreshes every view
 * of a timetable: the builder's slot lists and the principal's approved timetable. */
const SLOT_KEY_ROOTS: readonly QueryKey[] = [["timetable", "slots"], APPROVED_TIMETABLE_KEY_ROOT];

function invalidateAll(queryClient: QueryClient, keys: readonly QueryKey[]) {
  return Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
}

// ---------------------------------------------------------------------------
// Grades
// ---------------------------------------------------------------------------

export function useCreateGradeLevel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateGradeLevelInput): Promise<GradeLevel> => {
      const { data } = await api.POST("/api/academics/grade-levels", { body });
      if (!data) throw new Error("Grade creation returned no data.");
      return data;
    },
    onSuccess: () => invalidateAll(queryClient, [GRADE_LEVELS_KEY]),
  });
}

export function useUpdateGradeLevel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      gradeLevelId,
      body,
    }: {
      gradeLevelId: string;
      body: UpdateGradeLevelInput;
    }): Promise<GradeLevel> => {
      const { data } = await api.PATCH("/api/academics/grade-levels/{gradeLevelId}", {
        params: { path: { gradeLevelId } },
        body,
      });
      if (!data) throw new Error("Grade update returned no data.");
      return data;
    },
    // Sections and slots carry the grade's name.
    onSuccess: () =>
      invalidateAll(queryClient, [GRADE_LEVELS_KEY, SECTIONS_KEY_ROOT, ...SLOT_KEY_ROOTS]),
  });
}

/** 409 `GRADE_LEVEL_HAS_SECTIONS` while the grade still has sections in any year. */
export function useDeleteGradeLevel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (gradeLevelId: string): Promise<void> => {
      await api.DELETE("/api/academics/grade-levels/{gradeLevelId}", {
        params: { path: { gradeLevelId } },
      });
    },
    onSuccess: () => invalidateAll(queryClient, [GRADE_LEVELS_KEY]),
  });
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export function useCreateSection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateSectionInput): Promise<Section> => {
      const { data } = await api.POST("/api/academics/sections", { body });
      if (!data) throw new Error("Section creation returned no data.");
      return data;
    },
    onSuccess: () => invalidateAll(queryClient, [SECTIONS_KEY_ROOT]),
  });
}

export function useRenameSection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ sectionId, name }: { sectionId: string; name: string }) => {
      const { data } = await api.PATCH("/api/academics/sections/{sectionId}", {
        params: { path: { sectionId } },
        body: { name },
      });
      if (!data) throw new Error("Section update returned no data.");
      return data;
    },
    onSuccess: () => invalidateAll(queryClient, [SECTIONS_KEY_ROOT, ...SLOT_KEY_ROOTS]),
  });
}

/** 409 `SECTION_IN_USE` while classes or students still belong to the section. */
export function useDeleteSection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (sectionId: string): Promise<void> => {
      await api.DELETE("/api/academics/sections/{sectionId}", {
        params: { path: { sectionId } },
      });
    },
    onSuccess: () => invalidateAll(queryClient, [SECTIONS_KEY_ROOT]),
  });
}

// ---------------------------------------------------------------------------
// Section students
// ---------------------------------------------------------------------------

/** Rosters and student counts move (a placement can take a student out of another section), and the
 * placement enrols the student into the section's classes, so their enrolment counts move too. */
const PLACEMENT_KEY_ROOTS: readonly QueryKey[] = [
  SECTION_STUDENTS_KEY_ROOT,
  SECTIONS_KEY_ROOT,
  ENROLLMENT_COUNTS_KEY_ROOT,
];

/** Places a student in the section (moving them out of another section of the same year) and enrols
 * them into its planned/active classes; `skipped_class_ids` are the classes that were full. */
export function usePlaceStudent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      sectionId,
      studentId,
    }: {
      sectionId: string;
      studentId: string;
    }): Promise<SectionPlacementResult> => {
      const { data } = await api.POST("/api/academics/sections/{sectionId}/students", {
        params: { path: { sectionId } },
        body: { student_id: studentId },
      });
      if (!data) throw new Error("Section placement returned no data.");
      // Same `@studafy/api-client` readonly-array typing gap as `fetchStudentsPage` works around.
      return data as SectionPlacementResult;
    },
    onSuccess: () => invalidateAll(queryClient, PLACEMENT_KEY_ROOTS),
  });
}

export function useRemoveStudent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ sectionId, studentId }: { sectionId: string; studentId: string }) => {
      await api.DELETE("/api/academics/sections/{sectionId}/students/{studentId}", {
        params: { path: { sectionId, studentId } },
      });
    },
    onSuccess: () => invalidateAll(queryClient, PLACEMENT_KEY_ROOTS),
  });
}
