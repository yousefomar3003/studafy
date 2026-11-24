import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../../../lib/api";

import type { components } from "@studafy/api-client";

type Schemas = components["schemas"];

export type ExamPeriodSummary = Schemas["ExamPeriodSummary"];
export type ExamPeriod = Schemas["ExamPeriod"];
export type ExamPeriodInput = Schemas["ExamPeriodInput"];
export type ExamPeriodKind = Schemas["ExamPeriodKind"];
export type ExamSlot = Schemas["ExamSlot"];
export type ExamSlotInput = Schemas["ExamSlotInput"];
export type ExamSlotSeating = Schemas["ExamSlotSeating"];
export type ExamSeat = Schemas["ExamSeat"];
export type ExamClash = Schemas["ExamClash"];
export type SeatingStrategy = Schemas["ExamSeatingStrategy"];
export type Room = Schemas["Room"];
export type RoomCreateInput = Schemas["RoomCreateInput"];
export type RoomUpdateInput = Schemas["RoomUpdateInput"];

export const EXAM_PERIOD_KINDS: readonly ExamPeriodKind[] = [
  "midterm",
  "final",
  "monthly",
  "mock",
  "other",
];
export const SEATING_STRATEGIES: readonly SeatingStrategy[] = [
  "by_section",
  "alphabetical",
  "mixed",
];

/**
 * Exam weeks (000266): the school's exam periods, their timetable, rooms, seating, invigilators and
 * clashes. Everything about a period changes together (a slot's rooms change its seating and its
 * clashes), so every write refreshes every exam-weeks query.
 */
export const EXAM_WEEKS_KEY = ["exam-weeks"] as const;

const keys = {
  periods: (yearId: string) => [...EXAM_WEEKS_KEY, "periods", yearId] as const,
  period: (periodId: string) => [...EXAM_WEEKS_KEY, "period", periodId] as const,
  seating: (periodId: string) => [...EXAM_WEEKS_KEY, "seating", periodId] as const,
  clashes: (periodId: string) => [...EXAM_WEEKS_KEY, "clashes", periodId] as const,
  rooms: [...EXAM_WEEKS_KEY, "rooms"] as const,
  assessments: (yearId: string, gradeLevelId: string) =>
    [...EXAM_WEEKS_KEY, "assessments", yearId, gradeLevelId] as const,
};

function required<T>(data: unknown, what: string): T {
  if (data === undefined || data === null) throw new Error(`${what} returned no data.`);
  return data as T;
}

export function useExamPeriods(yearId: string | undefined) {
  return useQuery({
    queryKey: keys.periods(yearId ?? ""),
    enabled: yearId !== undefined,
    queryFn: async () => {
      const { data } = await api.GET("/api/academics/exam-periods", {
        params: { query: { academic_year_id: yearId! } },
      });
      return required<Schemas["ExamPeriodList"]>(data, "Exam periods").periods;
    },
  });
}

export function useExamPeriod(periodId: string | undefined) {
  return useQuery({
    queryKey: keys.period(periodId ?? ""),
    enabled: periodId !== undefined,
    queryFn: async () => {
      const { data } = await api.GET("/api/academics/exam-periods/{periodId}", {
        params: { path: { periodId: periodId! } },
      });
      return required<ExamPeriod>(data, "Exam period");
    },
  });
}

export function useExamPeriodSeating(periodId: string | undefined) {
  return useQuery({
    queryKey: keys.seating(periodId ?? ""),
    enabled: periodId !== undefined,
    queryFn: async () => {
      const { data } = await api.GET("/api/academics/exam-periods/{periodId}/seating", {
        params: { path: { periodId: periodId! } },
      });
      return required<Schemas["ExamPeriodSeating"]>(data, "Exam seating");
    },
  });
}

export function useExamPeriodClashes(periodId: string | undefined) {
  return useQuery({
    queryKey: keys.clashes(periodId ?? ""),
    enabled: periodId !== undefined,
    queryFn: async () => {
      const { data } = await api.GET("/api/academics/exam-periods/{periodId}/clashes", {
        params: { path: { periodId: periodId! } },
      });
      return required<Schemas["ExamClashList"]>(data, "Exam clashes").clashes;
    },
  });
}

/** Every room of the school, active or not, by code. */
export function useRooms() {
  return useQuery({
    queryKey: keys.rooms,
    queryFn: async () => {
      const rooms: Room[] = [];
      for (let page = 0; page < 20; page += 1) {
        const { data } = await api.GET("/api/academics/rooms", {
          params: { query: { limit: 100, offset: page * 100 } },
        });
        const list = required<Schemas["RoomList"]>(data, "Rooms");
        rooms.push(...list.rooms);
        if (list.rooms.length < 100 || rooms.length >= list.total) break;
      }
      return rooms;
    },
  });
}

/** The gradebook assessments of a grade's subjects that year, keyed by subject id. */
export function useGradeAssessments(yearId: string | undefined, gradeLevelId: string | undefined) {
  return useQuery({
    queryKey: keys.assessments(yearId ?? "", gradeLevelId ?? ""),
    enabled: yearId !== undefined && gradeLevelId !== undefined,
    queryFn: async () => {
      try {
        const { data } = await api.GET(
          "/api/grading/years/{yearId}/programs/{gradeLevelId}/subjects",
          { params: { path: { yearId: yearId!, gradeLevelId: gradeLevelId! } } },
        );
        const configs = required<Schemas["SubjectConfigList"]>(data, "Grade subjects").configs;
        const out = new Map<string, { id: string; name: string }[]>();
        for (const config of configs) {
          if (config.section_id !== null) continue;
          out.set(
            config.subject.id,
            config.assessments.map((assessment) => ({ id: assessment.id, name: assessment.name })),
          );
        }
        return out;
      } catch {
        // A grade without grading set up has no assessments to link to.
        return new Map<string, { id: string; name: string }[]>();
      }
    },
  });
}

function useExamWeeksMutation<Input, Output>(mutationFn: (input: Input) => Promise<Output>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: EXAM_WEEKS_KEY }),
  });
}

export function useSaveExamPeriod() {
  return useExamWeeksMutation(
    async ({ periodId, body }: { periodId: string | null; body: ExamPeriodInput }) => {
      if (periodId) {
        const { data } = await api.PUT("/api/academics/exam-periods/{periodId}", {
          params: { path: { periodId } },
          body,
        });
        return required<ExamPeriod>(data, "Exam period");
      }
      const { data } = await api.POST("/api/academics/exam-periods", { body });
      return required<ExamPeriod>(data, "Exam period");
    },
  );
}

export function useDeleteExamPeriod() {
  return useExamWeeksMutation(async (periodId: string) => {
    await api.DELETE("/api/academics/exam-periods/{periodId}", {
      params: { path: { periodId } },
    });
  });
}

export function useSaveExamSlot() {
  return useExamWeeksMutation(
    async ({
      periodId,
      slotId,
      body,
    }: {
      periodId: string;
      slotId: string | null;
      body: ExamSlotInput;
    }) => {
      if (slotId) {
        const { data } = await api.PUT("/api/academics/exam-slots/{slotId}", {
          params: { path: { slotId } },
          body,
        });
        return required<ExamSlot>(data, "Exam");
      }
      const { data } = await api.POST("/api/academics/exam-periods/{periodId}/slots", {
        params: { path: { periodId } },
        body,
      });
      return required<ExamSlot>(data, "Exam");
    },
  );
}

export function useDeleteExamSlot() {
  return useExamWeeksMutation(async (slotId: string) => {
    await api.DELETE("/api/academics/exam-slots/{slotId}", { params: { path: { slotId } } });
  });
}

export function useGenerateSeating() {
  return useExamWeeksMutation(
    async ({
      slotId,
      strategy,
      keepExisting,
    }: {
      slotId: string;
      strategy: SeatingStrategy;
      keepExisting: boolean;
    }) => {
      const { data } = await api.POST("/api/academics/exam-slots/{slotId}/seating", {
        params: { path: { slotId } },
        body: { strategy, keep_existing: keepExisting },
      });
      return required<Schemas["ExamSeatingResult"]>(data, "Exam seating");
    },
  );
}

export function useMoveSeat() {
  return useExamWeeksMutation(
    async ({
      slotId,
      studentId,
      roomId,
      seatNumber,
    }: {
      slotId: string;
      studentId: string;
      roomId: string;
      seatNumber: number;
    }) => {
      const { data } = await api.PUT("/api/academics/exam-slots/{slotId}/seats/{studentId}", {
        params: { path: { slotId, studentId } },
        body: { room_id: roomId, seat_number: seatNumber },
      });
      return required<ExamSlotSeating>(data, "Exam seating");
    },
  );
}

export function useSetInvigilators() {
  return useExamWeeksMutation(
    async ({
      slotId,
      rooms,
    }: {
      slotId: string;
      rooms: { room_id: string; teacher_ids: string[] }[];
    }) => {
      const { data } = await api.PUT("/api/academics/exam-slots/{slotId}/invigilators", {
        params: { path: { slotId } },
        body: { rooms },
      });
      return required<ExamSlot>(data, "Exam");
    },
  );
}

export function useSaveRoom() {
  return useExamWeeksMutation(
    async (
      input: { roomId: null; body: RoomCreateInput } | { roomId: string; body: RoomUpdateInput },
    ) => {
      if (input.roomId) {
        const { data } = await api.PATCH("/api/academics/rooms/{roomId}", {
          params: { path: { roomId: input.roomId } },
          body: input.body,
        });
        return required<Room>(data, "Room");
      }
      const { data } = await api.POST("/api/academics/rooms", {
        body: input.body as RoomCreateInput,
      });
      return required<Room>(data, "Room");
    },
  );
}
