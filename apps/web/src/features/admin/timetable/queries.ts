import { api } from "../../../lib/api";

import type { components } from "@studafy/api-client";

export type AcademicYear = components["schemas"]["AcademicYear"];
export type Term = components["schemas"]["Term"];
export type TimetableVersion = components["schemas"]["TimetableVersion"];
export type TimetableSlot = components["schemas"]["TimetableSlot"];
export type Class = components["schemas"]["Class"];
export type TimetableSettings = components["schemas"]["TimetableSettings"];
export type GradeLevel = components["schemas"]["GradeLevel"];
export type Section = components["schemas"]["Section"];

/** A teacher, joined with the display name their linked user account carries — `TeacherProfile`
 * itself has no name, only an employee number (see `fetchTeacherContacts` below). */
export interface TeacherContact {
  id: string;
  user_id: string;
  employee_number: string;
  display_name: string;
}

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const ACADEMIC_YEARS_KEY = ["timetable", "academic-years"] as const;
export function termsQueryKey(yearId: string) {
  return ["timetable", "terms", yearId] as const;
}
export function versionsQueryKey(termId: string) {
  return ["timetable", "versions", termId] as const;
}
export function slotsQueryKey(versionId: string) {
  return ["timetable", "slots", versionId] as const;
}
export function classesForTermQueryKey(termId: string) {
  return ["timetable", "classes", termId] as const;
}
export const TEACHER_CONTACTS_KEY = ["timetable", "teacher-contacts"] as const;
export const TIMETABLE_SETTINGS_KEY = ["timetable", "settings"] as const;
export const GRADE_LEVELS_KEY = ["timetable", "grade-levels"] as const;
/** Prefix of every per-year section list's key — invalidate this after changing sections. */
export const SECTIONS_KEY_ROOT = ["timetable", "sections"] as const;
export function sectionsQueryKey(yearId: string) {
  return [...SECTIONS_KEY_ROOT, yearId] as const;
}

// ---------------------------------------------------------------------------
// Pagination fan-outs
// ---------------------------------------------------------------------------

const MAX_PAGES = 20;

/** Exhausts an offset/limit/total-shaped list endpoint, capped at `MAX_PAGES` so a `total` that
 * undercounts can't page forever — same shape as the equivalent helper in `admin/students/queries.ts`,
 * kept local rather than shared since each admin feature owns its own data-fetching file. */
async function fetchAllOffsetPages<TRow>(
  fetchPage: (limit: number, offset: number) => Promise<{ rows: TRow[]; total: number }>,
  pageSize = 100,
): Promise<TRow[]> {
  const rows: TRow[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await fetchPage(pageSize, page * pageSize);
    rows.push(...result.rows);
    if (result.rows.length < pageSize || rows.length >= result.total) {
      break;
    }
  }
  return rows;
}

/** Exhausts a cursor-shaped list endpoint, capped at `MAX_PAGES`. */
async function fetchAllCursorPages<TRow>(
  fetchPage: (
    limit: number,
    cursor: string | undefined,
  ) => Promise<{ rows: TRow[]; nextCursor: string | null }>,
  pageSize = 100,
): Promise<TRow[]> {
  const rows: TRow[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await fetchPage(pageSize, cursor);
    rows.push(...result.rows);
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Academic years & terms
// ---------------------------------------------------------------------------

export async function fetchAcademicYears(): Promise<AcademicYear[]> {
  return fetchAllOffsetPages(async (limit, offset) => {
    const { data } = await api.GET("/api/academics/years", {
      params: { query: { limit, offset } },
    });
    return { rows: (data?.academic_years ?? []) as AcademicYear[], total: data?.total ?? 0 };
  });
}

export async function fetchTerms(yearId: string): Promise<Term[]> {
  return fetchAllOffsetPages(async (limit, offset) => {
    const { data } = await api.GET("/api/academics/years/{yearId}/terms", {
      params: { path: { yearId }, query: { limit, offset } },
    });
    return { rows: (data?.terms ?? []) as Term[], total: data?.total ?? 0 };
  });
}

// ---------------------------------------------------------------------------
// Timetable versions
// ---------------------------------------------------------------------------

export async function fetchVersions(termId: string): Promise<TimetableVersion[]> {
  return fetchAllOffsetPages(async (limit, offset) => {
    const { data } = await api.GET("/api/academics/timetable-versions", {
      params: { query: { term_id: termId, limit, offset } },
    });
    return {
      rows: (data?.timetable_versions ?? []) as TimetableVersion[],
      total: data?.total ?? 0,
    };
  });
}

/**
 * The version teachers and students are following. The database keeps at most one approved version
 * per term (publishing archives the previous one); sorting by approval time just makes the pick
 * deterministic either way.
 */
export function pickLiveVersion(
  versions: readonly TimetableVersion[],
): TimetableVersion | undefined {
  return versions
    .filter((version) => version.status === "approved")
    .sort((a, b) => (b.approved_at ?? "").localeCompare(a.approved_at ?? ""))[0];
}

/** The unpublished draft (or submitted version) being worked on, newest first. */
export function pickWorkingVersion(
  versions: readonly TimetableVersion[],
): TimetableVersion | undefined {
  return versions
    .filter((version) => version.status === "draft" || version.status === "pending")
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
}

// ---------------------------------------------------------------------------
// School week
// ---------------------------------------------------------------------------

export async function fetchTimetableSettings(): Promise<TimetableSettings> {
  const { data } = await api.GET("/api/academics/timetable-settings");
  if (!data) throw new Error("Timetable settings fetch returned no data.");
  return data as TimetableSettings;
}

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

export async function fetchSlots(versionId: string): Promise<TimetableSlot[]> {
  return fetchAllOffsetPages(async (limit, offset) => {
    const { data } = await api.GET("/api/academics/timetable-versions/{versionId}/slots", {
      params: { path: { versionId }, query: { limit, offset } },
    });
    return { rows: (data?.timetable_slots ?? []) as TimetableSlot[], total: data?.total ?? 0 };
  });
}

// ---------------------------------------------------------------------------
// Grades & sections
// ---------------------------------------------------------------------------

/** The school's grades, in their configured order (the API sorts by `sort_order`, then name). */
export async function fetchGradeLevels(): Promise<GradeLevel[]> {
  const { data } = await api.GET("/api/academics/grade-levels");
  return (data?.grade_levels ?? []) as GradeLevel[];
}

/** Every section of one academic year, ordered by grade then name. */
export async function fetchSections(yearId: string): Promise<Section[]> {
  return fetchAllOffsetPages(async (limit, offset) => {
    const { data } = await api.GET("/api/academics/sections", {
      params: { query: { academic_year_id: yearId, limit, offset } },
    });
    return { rows: (data?.sections ?? []) as Section[], total: data?.total ?? 0 };
  });
}

/**
 * Short "10-C" form of a section for tight spots such as a timetable cell: the grade's number when
 * its name has one ("Grade 10" → "10"), else the whole grade name. `null` when there's no section.
 */
export function compactSectionLabel(
  gradeLevelName: string | null,
  sectionName: string | null,
): string | null {
  if (!sectionName) return null;
  if (!gradeLevelName) return sectionName;
  const number = gradeLevelName.match(/\d+/g)?.at(-1);
  return `${number ?? gradeLevelName.trim()}-${sectionName}`;
}

// ---------------------------------------------------------------------------
// Classes eligible for a term
// ---------------------------------------------------------------------------

const SCHEDULABLE_CLASS_STATUSES = new Set<Class["status"]>(["planned", "active"]);

/** Classes the palette can offer for this version's term. Excludes `completed`/`cancelled` classes —
 * scheduling a class that will never run (or already has) has no legitimate use here. The DB's own
 * `enforce_timetable_slot_class_term` trigger is the real backstop; this is just what the palette
 * shows, not a substitute for it. */
export async function fetchClassesForTerm(termId: string): Promise<Class[]> {
  const rows = await fetchAllOffsetPages(async (limit, offset) => {
    const { data } = await api.GET("/api/academics/classes", {
      params: { query: { term_id: termId, limit, offset } },
    });
    return { rows: (data?.classes ?? []) as Class[], total: data?.total ?? 0 };
  });
  return rows.filter((klass) => SCHEDULABLE_CLASS_STATUSES.has(klass.status));
}

// ---------------------------------------------------------------------------
// Teachers (name-resolved)
// ---------------------------------------------------------------------------

/** `TeacherProfile` (from `GET /api/teachers`) carries only an employee number, no name — the name
 * lives on the linked user account. This fetches both directories and joins them client-side, the
 * same shape as `fetchStudentGuardians` in `admin/students/queries.ts` resolving `Guardian` against
 * `GET /api/users/{userId}`, except bulk here (one `role=INSTRUCTOR` fetch) since the grid needs every
 * teacher up front for the picker, not one at a time. */
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
        rows: (data?.users ?? []) as components["schemas"]["UserListItem"][],
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
