import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "../../../lib/api";

import type { AcademicYear, Term } from "../../admin/timetable/queries";
import type { components } from "@studafy/api-client";
import type { QueryClient } from "@tanstack/react-query";

export type CreateYearInput = components["schemas"]["CreateAcademicYearBody"];
export type UpdateYearInput = components["schemas"]["UpdateAcademicYearBody"];
export type CreateTermInput = components["schemas"]["CreateTermBody"];
export type UpdateTermInput = components["schemas"]["UpdateTermBody"];
export type RolloverResult = components["schemas"]["RolloverResult"];

/** Every cache that holds a year or a term: the principal pages, the timetable builder and the fee
 * structure builder each read them under their own key. */
function invalidateYearsAndTerms(queryClient: QueryClient) {
  return Promise.all(
    [["principal-school"], ["timetable"], ["finance", "fee-structures", "academic-years"]].map(
      (queryKey) => queryClient.invalidateQueries({ queryKey }),
    ),
  );
}

export function useCreateYear() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateYearInput): Promise<AcademicYear> => {
      const { data } = await api.POST("/api/academics/years", { body });
      if (!data) throw new Error("Academic year creation returned no data.");
      return data as AcademicYear;
    },
    onSuccess: () => invalidateYearsAndTerms(queryClient),
  });
}

export function useUpdateYear() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      yearId,
      body,
    }: {
      yearId: string;
      body: UpdateYearInput;
    }): Promise<AcademicYear> => {
      const { data } = await api.PATCH("/api/academics/years/{yearId}", {
        params: { path: { yearId } },
        body,
      });
      if (!data) throw new Error("Academic year update returned no data.");
      return data as AcademicYear;
    },
    onSuccess: () => invalidateYearsAndTerms(queryClient),
  });
}

export function useDeleteYear() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (yearId: string): Promise<void> => {
      await api.DELETE("/api/academics/years/{yearId}", { params: { path: { yearId } } });
    },
    onSuccess: () => invalidateYearsAndTerms(queryClient),
  });
}

/** Makes a planned year the school's current one: the active year closes and its enrolments are
 * marked completed, in one transaction (`rolloverAcademicYear`). */
export function useRolloverYear() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (yearId: string): Promise<RolloverResult> => {
      const { data } = await api.POST("/api/academics/years/{yearId}/rollover", {
        params: { path: { yearId } },
      });
      if (!data) throw new Error("Rollover returned no data.");
      return data;
    },
    // Enrolments changed too, so everything built on them (rosters, classes, sections) is stale.
    onSuccess: () => queryClient.invalidateQueries(),
  });
}

export function useCreateTerm() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateTermInput): Promise<Term> => {
      const { data } = await api.POST("/api/academics/years/{yearId}/terms", {
        params: { path: { yearId: body.academic_year_id } },
        body,
      });
      if (!data) throw new Error("Term creation returned no data.");
      return data as Term;
    },
    onSuccess: () => invalidateYearsAndTerms(queryClient),
  });
}

export function useUpdateTerm() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ termId, body }: { termId: string; body: UpdateTermInput }) => {
      const { data } = await api.PATCH("/api/academics/terms/{termId}", {
        params: { path: { termId } },
        body,
      });
      if (!data) throw new Error("Term update returned no data.");
      return data as Term;
    },
    onSuccess: () => invalidateYearsAndTerms(queryClient),
  });
}

export function useDeleteTerm() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (termId: string): Promise<void> => {
      await api.DELETE("/api/academics/terms/{termId}", { params: { path: { termId } } });
    },
    onSuccess: () => invalidateYearsAndTerms(queryClient),
  });
}
