import { api } from "../../../lib/api";

import type { components } from "@studafy/api-client";

export type Evaluation = components["schemas"]["TeacherEvaluation"];
export type EvaluationWithScores = components["schemas"]["EvaluationWithScores"];
export type EvaluationCriteriaTemplate = components["schemas"]["EvaluationCriteriaTemplate"];
export type EvaluationScore = components["schemas"]["EvaluationScore"];
export type EvaluationStatus = Evaluation["status"];

/** A teacher, joined with the display name their linked user account carries — `TeacherProfile`
 * itself has no name, only an employee number. Mirrors `fetchTeacherContacts` in
 * `admin/timetable/queries.ts`; duplicated here rather than imported since each feature in this
 * codebase owns its own data-fetching file. */
export interface TeacherContact {
  id: string;
  user_id: string;
  employee_number: string;
  display_name: string;
}

const PAGE_SIZE = 100;
const MAX_PAGES = 20;

export const EVALUATION_KEY_ROOT = ["teacher-evaluations"] as const;
export const EVALUATION_TEMPLATES_KEY_ROOT = ["evaluation-templates"] as const;
export const TEACHER_CONTACTS_KEY = [...EVALUATION_KEY_ROOT, "teacher-contacts"] as const;

export interface EvaluationListFilter {
  teacherId?: string;
  status?: EvaluationStatus;
}

export function evaluationListKey(filter: EvaluationListFilter) {
  return [
    ...EVALUATION_KEY_ROOT,
    "list",
    filter.teacherId ?? "all-teachers",
    filter.status ?? "all-statuses",
  ] as const;
}

export function evaluationDetailKey(evaluationId: string) {
  return [...EVALUATION_KEY_ROOT, "detail", evaluationId] as const;
}

export function evaluationTemplatesListKey(activeOnly: boolean) {
  return [...EVALUATION_TEMPLATES_KEY_ROOT, activeOnly ? "active" : "all"] as const;
}

/** Exhausts an offset/limit/total-shaped list endpoint, capped at `MAX_PAGES` so a `total` that
 * undercounts can't page forever — same shape as the equivalent helper in
 * `admin/timetable/queries.ts`, kept local since each feature owns its own data-fetching file. */
async function fetchAllOffsetPages<TRow>(
  fetchPage: (limit: number, offset: number) => Promise<{ rows: TRow[]; total: number }>,
): Promise<TRow[]> {
  const rows: TRow[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await fetchPage(PAGE_SIZE, page * PAGE_SIZE);
    rows.push(...result.rows);
    if (result.rows.length < PAGE_SIZE || rows.length >= result.total) break;
  }
  return rows;
}

/** Exhausts a cursor-shaped list endpoint, capped at `MAX_PAGES`. */
async function fetchAllCursorPages<TRow>(
  fetchPage: (
    limit: number,
    cursor: string | undefined,
  ) => Promise<{ rows: TRow[]; nextCursor: string | null }>,
): Promise<TRow[]> {
  const rows: TRow[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await fetchPage(PAGE_SIZE, cursor);
    rows.push(...result.rows);
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return rows;
}

/** Evaluations for one filter. Principals see every matching record; the server itself narrows this
 * further for a teacher caller (unshared evaluations never come back — see
 * `apps/api/src/modules/discipline/evaluation-service.ts`'s `listEvaluations`), so no client-side
 * visibility filtering is needed here. */
export async function fetchEvaluations(
  filter: EvaluationListFilter,
): Promise<EvaluationWithScores[]> {
  return fetchAllOffsetPages(async (limit, offset) => {
    const { data } = await api.GET("/api/evaluations", {
      params: {
        query: {
          limit,
          offset,
          ...(filter.teacherId ? { teacher_id: filter.teacherId } : {}),
          ...(filter.status ? { status: filter.status } : {}),
        },
      },
    });
    return { rows: (data?.evaluations ?? []) as EvaluationWithScores[], total: data?.total ?? 0 };
  });
}

export async function fetchEvaluation(evaluationId: string): Promise<EvaluationWithScores> {
  const { data } = await api.GET("/api/evaluations/{evaluationId}", {
    params: { path: { evaluationId } },
  });
  if (!data) throw new Error("Evaluation fetch returned no data.");
  // `readonly EvaluationScore[]` on `data.scores` loses its array prototype through the generated
  // response type here — the same pre-existing `@studafy/api-client` typing gap `discipline/queries.ts`
  // documents for `incidents`, just one level deeper (nested inside `scores`) since `EvaluationWithScores`
  // has an array field where `DisciplineIncident` has none. The annotation restores it without widening
  // to `any`.
  return data as EvaluationWithScores;
}

export async function fetchTemplates(activeOnly: boolean): Promise<EvaluationCriteriaTemplate[]> {
  const rows = await fetchAllOffsetPages(async (limit, offset) => {
    const { data } = await api.GET("/api/evaluations/templates", {
      params: { query: { limit, offset, ...(activeOnly ? { is_active: true } : {}) } },
    });
    return {
      rows: (data?.templates ?? []) as EvaluationCriteriaTemplate[],
      total: data?.total ?? 0,
    };
  });
  return [...rows].sort((a, b) => a.sort_order - b.sort_order);
}

export async function fetchTeacherContacts(): Promise<TeacherContact[]> {
  const [teachers, instructors] = await Promise.all([
    fetchAllCursorPages<components["schemas"]["TeacherProfile"]>(async (limit, cursor) => {
      const { data } = await api.GET("/api/teachers", { params: { query: { limit, cursor } } });
      return {
        rows: (data?.teachers ?? []) as components["schemas"]["TeacherProfile"][],
        nextCursor: data?.next_cursor ?? null,
      };
    }),
    fetchAllCursorPages<components["schemas"]["UserWithRoles"]>(async (limit, cursor) => {
      const { data } = await api.GET("/api/users", {
        params: { query: { role: "INSTRUCTOR", limit, cursor } },
      });
      return {
        rows: (data?.users ?? []) as components["schemas"]["UserWithRoles"][],
        nextCursor: data?.next_cursor ?? null,
      };
    }),
  ]);

  const userById = new Map(instructors.map((user) => [user.id, user]));

  return teachers.map((teacher) => {
    const user = userById.get(teacher.user_id);
    return {
      id: teacher.id,
      user_id: teacher.user_id,
      employee_number: teacher.employee_number,
      display_name: user?.display_name ?? user?.email ?? teacher.employee_number,
    };
  });
}
