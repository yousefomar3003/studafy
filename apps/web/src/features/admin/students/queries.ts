import { ApiError } from "@studafy/api-client";

import { api } from "../../../lib/api";
import { sessionStore } from "../../../lib/auth";
import { API_BASE_URL } from "../../../lib/config";

import type { components } from "@studafy/api-client";
import type { DateRangeValue } from "@studafy/ui";

export type StudentProfile = components["schemas"]["StudentProfile"];
export type Guardian = components["schemas"]["Guardian"];
export type Enrollment = components["schemas"]["Enrollment"];
export type Class = components["schemas"]["Class"];
export type UserWithRoles = components["schemas"]["UserWithRoles"];
export type StudentImport = components["schemas"]["ImportRecord"];

export interface StudentsFilters {
  search: string;
  status: StudentProfile["status"] | "";
  /**
   * `""` means "all classes." There is no `class_id` filter on `GET /api/students` — filtering by
   * class switches the list from `fetchStudentsPage` to `fetchStudentsInClass` below instead, which
   * is a materially different (and more expensive) fetch. See that function's doc for why.
   */
  classId: string;
  dateRange: DateRangeValue;
}

export const EMPTY_FILTERS: StudentsFilters = {
  search: "",
  status: "",
  classId: "",
  dateRange: {},
};

/** `YYYY-MM-DD` (FilterBar's format) to the ISO datetime the list query needs, at a day boundary. */
function toIsoDateBoundary(
  date: string | undefined,
  boundary: "start" | "end",
): string | undefined {
  if (!date) return undefined;
  return boundary === "start" ? `${date}T00:00:00.000Z` : `${date}T23:59:59.999Z`;
}

/** Query-key prefix shared by every cached page/view of the list, so mutations can invalidate/patch all of them at once. */
export const STUDENTS_LIST_KEY = ["students", "list"] as const;

export function studentsListQueryKey(filters: StudentsFilters, cursor: string | undefined) {
  return [...STUDENTS_LIST_KEY, filters, cursor] as const;
}

const PAGE_SIZE = 25;

/** The directory's default fetch: server-side search, status, and date-range filtering over the
 * school's full student count, which is what keeps search fast at 5k+ students. */
export async function fetchStudentsPage(filters: StudentsFilters, cursor: string | undefined) {
  const { data } = await api.GET("/api/students", {
    params: {
      query: {
        limit: PAGE_SIZE,
        cursor,
        status: filters.status || undefined,
        search: filters.search || undefined,
        created_from: toIsoDateBoundary(filters.dateRange.from, "start"),
        created_to: toIsoDateBoundary(filters.dateRange.to, "end"),
      },
    },
  });
  // `readonly StudentProfile[]` loses its array prototype through the generated response type here —
  // the same pre-existing `@studafy/api-client` typing gap `UsersListPage` works around, not a shape
  // mismatch. The annotation restores it without widening to `any`.
  return {
    students: (data?.students ?? []) as StudentProfile[],
    next_cursor: data?.next_cursor ?? null,
  };
}

// ---------------------------------------------------------------------------
// Offset-paginated fan-out helper, shared by the class roster and enrollment-history fetches below
// ---------------------------------------------------------------------------

const MAX_OFFSET_PAGES = 20;

/** Exhausts an offset/limit/total-shaped list endpoint. Capped at `MAX_OFFSET_PAGES` so a `total`
 * that undercounts (or a caller re-hitting a moving target) can't page forever. */
async function fetchAllOffsetPages<TRow>(
  fetchPage: (limit: number, offset: number) => Promise<{ rows: TRow[]; total: number }>,
  pageSize: number,
): Promise<TRow[]> {
  const rows: TRow[] = [];
  for (let page = 0; page < MAX_OFFSET_PAGES; page += 1) {
    const result = await fetchPage(pageSize, page * pageSize);
    rows.push(...result.rows);
    if (result.rows.length < pageSize || rows.length >= result.total) {
      break;
    }
  }
  return rows;
}

async function fetchAllClasses(status?: Class["status"]): Promise<Class[]> {
  return fetchAllOffsetPages(async (limit, offset) => {
    const { data } = await api.GET("/api/academics/classes", {
      params: { query: { status, limit, offset } },
    });
    return { rows: (data?.classes ?? []) as Class[], total: data?.total ?? 0 };
  }, 200);
}

async function fetchAllEnrollmentsForClass(classId: string): Promise<Enrollment[]> {
  return fetchAllOffsetPages(async (limit, offset) => {
    const { data } = await api.GET("/api/academics/classes/{classId}/enrollments", {
      params: { path: { classId }, query: { limit, offset } },
    });
    return { rows: (data?.enrollments ?? []) as Enrollment[], total: data?.total ?? 0 };
  }, 200);
}

// ---------------------------------------------------------------------------
// Classes (filter dropdown + class-scoped student lookup)
// ---------------------------------------------------------------------------

export const CLASSES_KEY = ["classes", "list"] as const;

/** Active classes, for the directory's class filter. Not `fetchAllClasses()` — a class you can't
 * currently filter students into (planned/completed/cancelled) doesn't belong in the picker. */
export async function fetchActiveClasses(): Promise<Class[]> {
  return fetchAllClasses("active");
}

export function studentsInClassQueryKey(classId: string, filters: StudentsFilters) {
  return [
    ...STUDENTS_LIST_KEY,
    "by-class",
    classId,
    filters.search,
    filters.status,
    filters.dateRange.from,
    filters.dateRange.to,
  ] as const;
}

/**
 * The directory's class filter, resolved client-side: there is no `class_id` filter on
 * `GET /api/students`, and `Enrollment` carries only a `student_id` — no name or admission number —
 * so this fetches the class's enrollment roster, fetches each enrolled student's profile, and
 * filters/searches in memory.
 *
 * This is an N+1 fan-out bounded by class size (a class's `capacity`, typically well under a
 * hundred), not by the school's total student count — a real tradeoff, not a bug, but it does not
 * scale to "all classes at once" and must not be reused for that (see `fetchStudentEnrollmentHistory`
 * for what that fan-out costs). The correct fix is a `class_id` filter on `listStudents`; this exists
 * to unblock the UI until one ships.
 */
export async function fetchStudentsInClass(
  classId: string,
  filters: StudentsFilters,
): Promise<StudentProfile[]> {
  const enrollments = await fetchAllEnrollmentsForClass(classId);
  const studentIds = [...new Set(enrollments.map((enrollment) => enrollment.student_id))];

  const students = await Promise.all(
    studentIds.map(async (studentId) => {
      const { data } = await api.GET("/api/students/{studentId}", {
        params: { path: { studentId } },
      });
      return data as StudentProfile | undefined;
    }),
  );

  const search = filters.search.trim().toLowerCase();
  const fromMs = filters.dateRange.from ? new Date(filters.dateRange.from).getTime() : undefined;
  const toMs = filters.dateRange.to
    ? new Date(`${filters.dateRange.to}T23:59:59.999Z`).getTime()
    : undefined;

  return students.filter((student): student is StudentProfile => {
    if (!student) return false;
    if (filters.status && student.status !== filters.status) return false;
    if (search) {
      const haystack =
        `${student.first_name} ${student.last_name} ${student.admission_number}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    const createdMs = new Date(student.created_at).getTime();
    if (fromMs !== undefined && createdMs < fromMs) return false;
    if (toMs !== undefined && createdMs > toMs) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Single student
// ---------------------------------------------------------------------------

export function studentQueryKey(studentId: string) {
  return ["students", "detail", studentId] as const;
}

export async function fetchStudent(studentId: string): Promise<StudentProfile> {
  const { data } = await api.GET("/api/students/{studentId}", { params: { path: { studentId } } });
  if (!data) throw new Error("Student not found.");
  return data as StudentProfile;
}

// ---------------------------------------------------------------------------
// Guardians
// ---------------------------------------------------------------------------

export interface GuardianContact extends Guardian {
  /** Resolved from `parent_user_id` — `null` only if the linked account has since been removed. */
  user: UserWithRoles | null;
}

export function studentGuardiansQueryKey(studentId: string) {
  return ["students", "detail", studentId, "guardians"] as const;
}

/** Resolves each guardian link's contact info via `GET /api/users/{userId}` — `Guardian` itself
 * carries only the parent's user id, family id, and relationship, no name/email. A student rarely
 * has more than a handful of guardians, so one request per link is a non-issue at this fan-out
 * (unlike the class-roster and enrollment-history fetches above/below, whose fan-outs are explicitly
 * flagged as a scaling tradeoff). */
export async function fetchStudentGuardians(studentId: string): Promise<GuardianContact[]> {
  const { data } = await api.GET("/api/students/{studentId}/guardians", {
    params: { path: { studentId } },
  });
  const guardians = (data ?? []) as Guardian[];

  return Promise.all(
    guardians.map(async (guardian) => {
      const { data: user } = await api.GET("/api/users/{userId}", {
        params: { path: { userId: guardian.parent_user_id } },
      });
      return { ...guardian, user: (user ?? null) as UserWithRoles | null };
    }),
  );
}

const PARENT_SEARCH_LIMIT = 10;

export function parentSearchQueryKey(search: string) {
  return ["users", "search-parents", search] as const;
}

/** Parent-user search backing the "link a guardian" picker in `LinkGuardianModal`. */
export async function searchParentUsers(search: string): Promise<UserWithRoles[]> {
  if (!search.trim()) {
    return [];
  }
  const { data } = await api.GET("/api/users", {
    params: { query: { role: "PARENT", search: search.trim(), limit: PARENT_SEARCH_LIMIT } },
  });
  return (data?.users ?? []) as UserWithRoles[];
}

// ---------------------------------------------------------------------------
// Enrollment history
// ---------------------------------------------------------------------------

export interface EnrollmentHistoryEntry extends Enrollment {
  class: Class | null;
}

export function studentEnrollmentHistoryQueryKey(studentId: string) {
  return ["students", "detail", studentId, "enrollment-history"] as const;
}

/**
 * A student's full enrollment history, assembled client-side. There is no
 * `GET /api/students/{studentId}/enrollments` and no `student_id` filter on `listEnrollments` — only
 * `GET /api/academics/classes/{classId}/enrollments`, scoped to one class at a time. So this fetches
 * every class in the school (any status, since a withdrawn-from or completed class is exactly what
 * "history" means), pulls each class's enrollment roster in parallel, and keeps the rows for this
 * student.
 *
 * This is a real scaling limitation, not a stylistic choice: it re-fetches the whole school's
 * enrollment data on every profile visit, at a cost of total-classes-in-the-school requests, and that
 * cost is paid again on every visit to every student's profile. It works today because a school's
 * class count is bounded (unlike its student count, which is what the search-performance acceptance
 * criterion is actually about). The correct fix is a dedicated student-scoped endpoint; this exists
 * to unblock the UI until one ships — see ST-189 notes.
 */
export async function fetchStudentEnrollmentHistory(
  studentId: string,
): Promise<EnrollmentHistoryEntry[]> {
  const classes = await fetchAllClasses();
  const classById = new Map(classes.map((klass) => [klass.id, klass]));

  const enrollmentsByClass = await Promise.all(
    classes.map((klass) => fetchAllEnrollmentsForClass(klass.id)),
  );

  return enrollmentsByClass
    .flat()
    .filter((enrollment) => enrollment.student_id === studentId)
    .map((enrollment) => ({ ...enrollment, class: classById.get(enrollment.class_id) ?? null }))
    .sort((a, b) => new Date(b.enrolled_at).getTime() - new Date(a.enrolled_at).getTime());
}

// ---------------------------------------------------------------------------
// CSV import
// ---------------------------------------------------------------------------

export function studentImportQueryKey(importId: string) {
  return ["students", "import", importId] as const;
}

/** `GET /api/imports/students/template` — a CSV with the expected headers and an example row. */
export async function fetchStudentImportTemplate(): Promise<string> {
  const { data } = await api.GET("/api/imports/students/template");
  return typeof data === "string" ? data : "";
}

/** `GET /api/imports/students/{importId}` — polled while the confirmed import is processing. */
export async function fetchStudentImport(importId: string): Promise<StudentImport> {
  const { data } = await api.GET("/api/imports/students/{importId}", {
    params: { path: { importId } },
  });
  if (!data) throw new Error("Import not found.");
  return data as StudentImport;
}

export interface UploadProgress {
  loaded: number;
  total: number;
  percent: number;
}

/** Turns an XHR's raw header text into a `Headers` object, so a failed response can be handed to
 * `ApiError.fromResponse` the same way the typed client's problem+json middleware does. */
function headersFromXhr(xhr: XMLHttpRequest): Headers {
  const headers = new Headers();
  for (const line of xhr.getAllResponseHeaders().trim().split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    headers.append(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return headers;
}

/**
 * `POST /api/imports/students/upload` — the dry-run validation call. Uploaded as raw `text/csv`,
 * not JSON, matching the API's contract (see `apps/api/src/modules/imports/routes/import-routes.ts`).
 *
 * Sent via `XMLHttpRequest` rather than the typed `api` client: `openapi-fetch` (and `fetch` request
 * bodies generally, in the browsers this app supports) has no upload-progress event, and the import
 * flow's UX requirement is a real progress bar for files up to the API's 10,000-row cap, not a fake
 * one. Errors are normalized back into the same `ApiError` the typed client throws, so callers don't
 * need a second error-handling path — see `headersFromXhr`.
 */
export function uploadStudentImportCsv(
  file: File,
  onProgress?: (progress: UploadProgress) => void,
): Promise<StudentImport> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE_URL}/api/imports/students/upload`);
    xhr.setRequestHeader("Content-Type", "text/csv");
    xhr.setRequestHeader("X-File-Name", file.name);

    xhr.upload.onprogress = (event) => {
      if (!onProgress || !event.lengthComputable) return;
      onProgress({
        loaded: event.loaded,
        total: event.total,
        percent: Math.round((event.loaded / event.total) * 100),
      });
    };

    xhr.onload = () => {
      void (async () => {
        const response = new Response(xhr.response as string, {
          status: xhr.status,
          headers: headersFromXhr(xhr),
        });
        if (!response.ok) {
          reject(await ApiError.fromResponse(response));
          return;
        }
        resolve((await response.json()) as StudentImport);
      })();
    };
    xhr.onerror = () => reject(new Error("Network error while uploading the CSV."));

    void sessionStore.getToken().then((token) => {
      if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      xhr.send(file);
    });
  });
}
