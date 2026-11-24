import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../../../lib/api";

import type { components } from "@studafy/api-client";

type Schemas = components["schemas"];

export type SubjectCoordinator = Schemas["SubjectCoordinator"];
export type SubjectCoordinatorBody = Schemas["SubjectCoordinatorBody"];

/**
 * Subject coordinators (000260): who coordinates which subject in an academic year, and for which
 * grade levels. A coordinator then reads every covered section's marks, predicted grades and
 * subject results in the mobile app, read-only.
 */
export const SUBJECT_COORDINATORS_KEY = ["subject-coordinators"] as const;

const listKey = (yearId: string) => [...SUBJECT_COORDINATORS_KEY, yearId] as const;

/** The response body re-typed as its schema (see `required` in queries.ts for why). */
function required<T>(data: unknown, what: string): T {
  if (data === undefined || data === null) throw new Error(`${what} returned no data.`);
  return data as T;
}

export function useSubjectCoordinators(yearId: string) {
  return useQuery({
    queryKey: listKey(yearId),
    queryFn: async () => {
      const { data } = await api.GET("/api/grading/years/{yearId}/subject-coordinators", {
        params: { path: { yearId } },
      });
      return required<Schemas["SubjectCoordinatorList"]>(data, "Subject coordinators").coordinators;
    },
  });
}

function useCoordinatorMutation<Input, Output>(mutationFn: (input: Input) => Promise<Output>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: SUBJECT_COORDINATORS_KEY }),
  });
}

export function useCreateSubjectCoordinator() {
  return useCoordinatorMutation(
    async ({ yearId, body }: { yearId: string; body: SubjectCoordinatorBody }) => {
      const { data } = await api.POST("/api/grading/years/{yearId}/subject-coordinators", {
        params: { path: { yearId } },
        body,
      });
      return required<SubjectCoordinator>(data, "Subject coordinator");
    },
  );
}

export function useUpdateSubjectCoordinator() {
  return useCoordinatorMutation(
    async ({
      coordinatorId,
      gradeLevelIds,
    }: {
      coordinatorId: string;
      gradeLevelIds: string[];
    }) => {
      const { data } = await api.PATCH("/api/grading/subject-coordinators/{coordinatorId}", {
        params: { path: { coordinatorId } },
        body: { grade_level_ids: gradeLevelIds },
      });
      return required<SubjectCoordinator>(data, "Subject coordinator");
    },
  );
}

export function useDeleteSubjectCoordinator() {
  return useCoordinatorMutation(async (coordinatorId: string) => {
    await api.DELETE("/api/grading/subject-coordinators/{coordinatorId}", {
      params: { path: { coordinatorId } },
    });
  });
}
