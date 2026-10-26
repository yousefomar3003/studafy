import { useQuery } from "@tanstack/react-query";

import { api } from "../../../lib/api";
import {
  EMPTY_FILTERS,
  fetchStudentsPage,
  studentsListQueryKey,
} from "../../admin/students/queries";
import {
  GRADE_LEVELS_KEY,
  fetchGradeLevels,
  fetchSections,
  sectionsQueryKey,
} from "../../admin/timetable/queries";

import type { Class, Section } from "../../admin/timetable/queries";
import type { components } from "@studafy/api-client";
import type { TFunction } from "i18next";

export type { GradeLevel, Section } from "../../admin/timetable/queries";
export type SectionStudent = components["schemas"]["SectionStudent"];
export type SectionPlacementResult = components["schemas"]["SectionPlacementResult"];

/**
 * Data for the grades & sections page and the class-section picker. Grades and sections are read
 * through the timetable builder's fetchers and cache keys, so a change made here shows up in the
 * builder's Grade/Section filters without a reload; the section roster and its classes are only
 * needed here.
 */

export function useGradeLevels() {
  return useQuery({ queryKey: GRADE_LEVELS_KEY, queryFn: fetchGradeLevels });
}

export function useSections(yearId: string | undefined) {
  return useQuery({
    queryKey: sectionsQueryKey(yearId ?? ""),
    queryFn: () => fetchSections(yearId!),
    enabled: yearId !== undefined,
  });
}

/** "Grade 10 – C": how a section is named wherever it stands on its own (selects, lists). */
export function sectionDisplayName(
  section: Pick<Section, "grade_level_name" | "name">,
  t: TFunction,
): string {
  return t("principal.sections.sectionLabel", {
    grade: section.grade_level_name,
    section: section.name,
  });
}

/** Prefix of every section roster's key — invalidate this after placing or removing students. */
export const SECTION_STUDENTS_KEY_ROOT = ["sections", "students"] as const;

export function useSectionStudents(sectionId: string | undefined) {
  return useQuery({
    queryKey: [...SECTION_STUDENTS_KEY_ROOT, sectionId],
    enabled: sectionId !== undefined,
    queryFn: async () => {
      const { data } = await api.GET("/api/academics/sections/{sectionId}/students", {
        params: { path: { sectionId: sectionId! } },
      });
      return (data?.students ?? []) as SectionStudent[];
    },
  });
}

/** The section's classes — used to name the classes a placement couldn't enrol the student into. */
export function useSectionClasses(sectionId: string | undefined) {
  return useQuery({
    queryKey: ["sections", "classes", sectionId],
    enabled: sectionId !== undefined,
    queryFn: async () => {
      const { data } = await api.GET("/api/academics/classes", {
        params: { query: { section_id: sectionId!, limit: 100 } },
      });
      return (data?.classes ?? []) as Class[];
    },
  });
}

/** Server-side student search, the same request (and cache entry) as the admin student directory's. */
export function useStudentSearch(search: string) {
  const filters = { ...EMPTY_FILTERS, search: search.trim() };
  return useQuery({
    queryKey: studentsListQueryKey(filters, undefined),
    queryFn: () => fetchStudentsPage(filters, undefined),
    enabled: filters.search !== "",
  });
}
