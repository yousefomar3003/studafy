import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../../../lib/api";
import {
  fetchAcademicYears,
  fetchRooms,
  fetchSlots,
  fetchTeacherContacts,
  fetchTerms,
  fetchVersions,
} from "../../admin/timetable/queries";

import type { AcademicYear, Class, Term } from "../../admin/timetable/queries";
import type { components } from "@studafy/api-client";

export type Course = components["schemas"]["Course"];
export type Exam = components["schemas"]["Exam"];
export type Gradebook = components["schemas"]["Gradebook"];
export type GradeSubmission = components["schemas"]["GradeSubmission"];
export type StudentProfile = components["schemas"]["StudentProfile"];
export type SchoolEvent = components["schemas"]["SchoolEvent"];
export type SchoolEventKind = SchoolEvent["kind"];
export type SchoolEventInput = components["schemas"]["CreateSchoolEventBody"];

export const SCHOOL_EVENT_KINDS = ["holiday", "event", "meeting", "exam_period"] as const;

/**
 * Data for the principal's school-oversight pages (grades, calendar, timetable, classes, students).
 * The academic structure (years, terms, classes, timetable, teachers, rooms) is read through the
 * admin timetable builder's fetchers so both views share one definition of each request; this file
 * adds the reads only the principal pages need. Query keys live under "principal-school" so they
 * never collide with the admin builder's cache entries.
 */
const KEY = "principal-school";

// ---------------------------------------------------------------------------
// Academic structure
// ---------------------------------------------------------------------------

const CLASS_PAGE_SIZE = 100;
const MAX_CLASS_PAGES = 20;

/**
 * Every class in a term, whatever its status. Unlike the timetable builder's fetcher (which keeps
 * only schedulable classes), a principal looking back at a past term still needs its completed
 * classes — their gradebooks and rosters don't stop mattering when the term ends.
 */
async function fetchClassesForTerm(termId: string): Promise<Class[]> {
  const classes: Class[] = [];
  for (let page = 0; page < MAX_CLASS_PAGES; page += 1) {
    const { data } = await api.GET("/api/academics/classes", {
      params: {
        query: { term_id: termId, limit: CLASS_PAGE_SIZE, offset: page * CLASS_PAGE_SIZE },
      },
    });
    const rows = (data?.classes ?? []) as Class[];
    classes.push(...rows);
    if (rows.length < CLASS_PAGE_SIZE || classes.length >= (data?.total ?? 0)) break;
  }
  return classes;
}

/** Every course in the catalog. Courses are listed per subject, so this walks the subjects first —
 * used to resolve course codes in the classes CSV import. */
async function fetchCourses(): Promise<Course[]> {
  const subjectIds: string[] = [];
  for (let page = 0; page < MAX_CLASS_PAGES; page += 1) {
    const { data } = await api.GET("/api/academics/subjects", {
      params: { query: { limit: CLASS_PAGE_SIZE, offset: page * CLASS_PAGE_SIZE } },
    });
    const rows = (data?.subjects ?? []) as components["schemas"]["Subject"][];
    subjectIds.push(...rows.map((subject) => subject.id));
    if (rows.length < CLASS_PAGE_SIZE || subjectIds.length >= (data?.total ?? 0)) break;
  }
  const perSubject = await Promise.all(
    subjectIds.map(async (subjectId) => {
      const courses: Course[] = [];
      for (let page = 0; page < MAX_CLASS_PAGES; page += 1) {
        const { data } = await api.GET("/api/academics/subjects/{subjectId}/courses", {
          params: {
            path: { subjectId },
            query: { limit: CLASS_PAGE_SIZE, offset: page * CLASS_PAGE_SIZE },
          },
        });
        const rows = (data?.courses ?? []) as Course[];
        courses.push(...rows);
        if (rows.length < CLASS_PAGE_SIZE || courses.length >= (data?.total ?? 0)) break;
      }
      return courses;
    }),
  );
  return perSubject.flat();
}

export function useCourses(enabled = true) {
  return useQuery({ queryKey: [KEY, "courses"], queryFn: fetchCourses, enabled });
}

/** Prefix of every per-term class list's query key — invalidate this after creating classes. */
export const CLASSES_KEY_ROOT = [KEY, "classes"] as const;

export function useAcademicYears() {
  return useQuery({ queryKey: [KEY, "years"], queryFn: fetchAcademicYears });
}

export function useTerms(yearId: string | undefined) {
  return useQuery({
    queryKey: [KEY, "terms", yearId],
    queryFn: () => fetchTerms(yearId!),
    enabled: yearId !== undefined,
  });
}

export function useClassesForTerm(termId: string | undefined) {
  return useQuery({
    queryKey: [...CLASSES_KEY_ROOT, termId],
    queryFn: () => fetchClassesForTerm(termId!),
    enabled: termId !== undefined,
  });
}

export function useTeacherContacts() {
  return useQuery({ queryKey: [KEY, "teachers"], queryFn: fetchTeacherContacts });
}

export function useRooms() {
  return useQuery({ queryKey: [KEY, "rooms"], queryFn: fetchRooms });
}

/** Terms of several years at once — the calendar shows every term overlapping its month. */
export function useTermsForYears(yearIds: readonly string[]) {
  return useQueries({
    queries: yearIds.map((yearId) => ({
      queryKey: [KEY, "terms", yearId],
      queryFn: () => fetchTerms(yearId),
    })),
    combine: (results) => results.flatMap((result) => result.data ?? []),
  });
}

/** Classes of several terms at once, for the calendar's exam fan-out. */
export function useClassesForTerms(termIds: readonly string[]) {
  return useQueries({
    queries: termIds.map((termId) => ({
      queryKey: [...CLASSES_KEY_ROOT, termId],
      queryFn: () => fetchClassesForTerm(termId),
    })),
    combine: (results) => results.flatMap((result) => result.data ?? []),
  });
}

/** The year marked active, else the one with the latest start — what a principal means by "this year". */
export function pickCurrentYear(years: readonly AcademicYear[]): AcademicYear | undefined {
  return (
    years.find((year) => year.status === "active") ??
    [...years].sort((a, b) => b.starts_on.localeCompare(a.starts_on))[0]
  );
}

/** The term containing `today`, else the next one to start, else the most recent. */
export function pickCurrentTerm(terms: readonly Term[], today: string): Term | undefined {
  const ordered = [...terms].sort((a, b) => a.starts_on.localeCompare(b.starts_on));
  return (
    ordered.find((term) => term.starts_on <= today && today <= term.ends_on) ??
    ordered.find((term) => term.starts_on > today) ??
    ordered.at(-1)
  );
}

/** Today as YYYY-MM-DD in the browser's own calendar, matching how term and event dates are stored. */
export function todayIso(now = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

// ---------------------------------------------------------------------------
// Timetable
// ---------------------------------------------------------------------------

/** The term's approved timetable version (what is actually running), with its slots. */
export function useApprovedTimetable(termId: string | undefined) {
  return useQuery({
    queryKey: [KEY, "timetable", termId],
    enabled: termId !== undefined,
    queryFn: async () => {
      const versions = await fetchVersions(termId!);
      const version = versions.find((candidate) => candidate.status === "approved") ?? null;
      const slots = version ? await fetchSlots(version.id) : [];
      return { version, slots };
    },
  });
}

// ---------------------------------------------------------------------------
// Students and enrolments
// ---------------------------------------------------------------------------

const STUDENT_PAGE_SIZE = 100;
const MAX_STUDENT_PAGES = 50;

async function fetchAllStudents(): Promise<StudentProfile[]> {
  const students: StudentProfile[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_STUDENT_PAGES; page += 1) {
    const { data } = await api.GET("/api/students", {
      params: { query: { limit: STUDENT_PAGE_SIZE, ...(cursor ? { cursor } : {}) } },
    });
    students.push(...((data?.students ?? []) as StudentProfile[]));
    if (!data?.next_cursor) break;
    cursor = data.next_cursor;
  }
  return students;
}

export function useAllStudents() {
  return useQuery({ queryKey: [KEY, "students"], queryFn: fetchAllStudents });
}

export function studentDisplayName(student: StudentProfile): string {
  return `${student.preferred_name ?? student.first_name} ${student.last_name}`;
}

/** Active enrolment count per class, one small request per class. */
export function useEnrollmentCounts(classIds: readonly string[]) {
  return useQueries({
    queries: classIds.map((classId) => ({
      queryKey: [KEY, "enrollment-count", classId],
      queryFn: async () => {
        const { data } = await api.GET("/api/academics/classes/{classId}/enrollments", {
          params: { path: { classId }, query: { status: "active", limit: 1 } },
        });
        return data?.total ?? 0;
      },
    })),
    combine: (results) =>
      // eslint-disable-next-line security/detect-object-injection -- `index` comes from mapping `classIds`, which `results` mirrors one-to-one
      new Map(classIds.map((classId, index) => [classId, results[index]?.data])),
  });
}

// ---------------------------------------------------------------------------
// Grades
// ---------------------------------------------------------------------------

export function useClassGradebook(classId: string | undefined) {
  return useQuery({
    queryKey: [KEY, "gradebook", classId],
    enabled: classId !== undefined,
    queryFn: async () => {
      const { data: gradebook } = await api.GET("/api/grades/gradebooks", {
        params: { query: { classId: classId! } },
      });
      if (!gradebook) return { gradebook: null, submissions: [] as GradeSubmission[] };
      const { data } = await api.GET("/api/grades/gradebooks/{gradebookId}/entry", {
        params: { path: { gradebookId: gradebook.id } },
      });
      return { gradebook, submissions: (data?.submissions ?? []) as GradeSubmission[] };
    },
  });
}

// ---------------------------------------------------------------------------
// Calendar: exams and school events
// ---------------------------------------------------------------------------

/** Every exam across the given classes. The exams endpoint is per class, so this fans out. */
export function useExamsForClasses(classes: readonly Class[]) {
  return useQueries({
    queries: classes.map((klass) => ({
      queryKey: [KEY, "exams", klass.id],
      queryFn: async () => {
        const { data } = await api.GET("/api/academics/exams", {
          params: { query: { class_id: klass.id, limit: 100 } },
        });
        return (data?.exams ?? []) as Exam[];
      },
    })),
    combine: (results) => ({
      exams: results.flatMap((result) => result.data ?? []),
      isPending: results.some((result) => result.isPending),
    }),
  });
}

/** Prefix of every school-events window's query key — invalidate this after creating events. */
export const SCHOOL_EVENTS_KEY_ROOT = [KEY, "events"] as const;

export function schoolEventsKey(from: string, to: string) {
  return [...SCHOOL_EVENTS_KEY_ROOT, from, to] as const;
}

export function useSchoolEvents(from: string, to: string) {
  return useQuery({
    queryKey: schoolEventsKey(from, to),
    queryFn: async () => {
      const { data, error } = await api.GET("/api/school-events", {
        params: { query: { from, to } },
      });
      if (error) throw new Error("Failed to load calendar events");
      return data.items as SchoolEvent[];
    },
  });
}

function useInvalidateEvents() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: SCHOOL_EVENTS_KEY_ROOT });
}

export function useCreateSchoolEvent() {
  const invalidate = useInvalidateEvents();
  return useMutation({
    mutationFn: async (body: SchoolEventInput) => {
      const { data, error } = await api.POST("/api/school-events", { body });
      if (error) throw new Error("Failed to add the event");
      return data;
    },
    onSuccess: invalidate,
  });
}

export function useUpdateSchoolEvent() {
  const invalidate = useInvalidateEvents();
  return useMutation({
    mutationFn: async ({ id, body }: { id: string; body: SchoolEventInput }) => {
      const { data, error } = await api.PATCH("/api/school-events/{eventId}", {
        params: { path: { eventId: id } },
        body,
      });
      if (error) throw new Error("Failed to save the event");
      return data;
    },
    onSuccess: invalidate,
  });
}

export function useDeleteSchoolEvent() {
  const invalidate = useInvalidateEvents();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await api.DELETE("/api/school-events/{eventId}", {
        params: { path: { eventId: id } },
      });
      if (error) throw new Error("Failed to remove the event");
    },
    onSuccess: invalidate,
  });
}
