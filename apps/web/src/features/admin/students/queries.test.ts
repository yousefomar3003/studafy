// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";

interface RequestInit {
  params?: { path?: Record<string, string>; query?: Record<string, unknown> };
}

const getMock = mock((_path: string, _init?: RequestInit) =>
  Promise.resolve<unknown>({ data: {} }),
);

mock.module("../../../lib/api", () => ({ api: { GET: getMock } }));

const { fetchStudentEnrollmentHistory, fetchStudentsInClass } = await import("./queries");

function student(id: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    school_id: "school-1",
    user_id: `user-${id}`,
    first_name: "First",
    middle_name: null,
    last_name: id,
    preferred_name: null,
    date_of_birth: null,
    nationality_country_id: null,
    admission_number: `ADM-${id}`,
    admission_date: null,
    status: "enrolled",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  getMock.mockReset();
});

describe("fetchStudentsInClass", () => {
  test("exhausts the enrollment roster across offset pages, then resolves and filters student profiles", async () => {
    const enrollmentPage1 = Array.from({ length: 200 }, (_, i) => ({
      school_id: "school-1",
      class_id: "class-1",
      student_id: `s${i}`,
      status: "active",
      enrolled_at: "2026-01-01T00:00:00.000Z",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      withdrawn_at: null,
    }));
    const enrollmentPage2 = [
      {
        school_id: "school-1",
        class_id: "class-1",
        student_id: "s200",
        status: "active",
        enrolled_at: "2026-01-01T00:00:00.000Z",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        withdrawn_at: null,
      },
    ];

    getMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/api/academics/classes/{classId}/enrollments") {
        const offset = (init?.params?.query?.offset as number) ?? 0;
        if (offset === 0) {
          return Promise.resolve<unknown>({
            data: { enrollments: enrollmentPage1, total: 201 },
          });
        }
        return Promise.resolve<unknown>({ data: { enrollments: enrollmentPage2, total: 201 } });
      }
      if (path === "/api/students/{studentId}") {
        const studentId = init?.params?.path?.studentId ?? "";
        // Only s0 is "enrolled"; every other id is "withdrawn" so the status filter below has
        // something real to exclude.
        return Promise.resolve<unknown>({
          data: student(studentId, { status: studentId === "s0" ? "enrolled" : "withdrawn" }),
        });
      }
      return Promise.resolve<unknown>({ data: {} });
    });

    const result = await fetchStudentsInClass("class-1", {
      search: "",
      status: "enrolled",
      classId: "class-1",
      dateRange: {},
    });

    // Both offset pages were fetched (201 enrollments needed the second page).
    const enrollmentCalls = getMock.mock.calls.filter(
      ([path]) => path === "/api/academics/classes/{classId}/enrollments",
    );
    expect(enrollmentCalls.length).toBe(2);

    // Only the one "enrolled" student survives the status filter.
    expect(result.map((s) => s.id)).toEqual(["s0"]);
  });
});

describe("fetchStudentEnrollmentHistory", () => {
  test("keeps only the target student's rows across every class, newest first", async () => {
    getMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/api/academics/classes") {
        return Promise.resolve<unknown>({
          data: {
            classes: [
              { id: "class-1", code: "MATH-101", status: "active" },
              { id: "class-2", code: "SCI-101", status: "completed" },
            ],
            total: 2,
          },
        });
      }
      if (path === "/api/academics/classes/{classId}/enrollments") {
        const classId = init?.params?.path?.classId;
        if (classId === "class-1") {
          return Promise.resolve<unknown>({
            data: {
              enrollments: [
                {
                  school_id: "school-1",
                  class_id: "class-1",
                  student_id: "target",
                  status: "active",
                  enrolled_at: "2026-06-01T00:00:00.000Z",
                  created_at: "2026-06-01T00:00:00.000Z",
                  updated_at: "2026-06-01T00:00:00.000Z",
                  withdrawn_at: null,
                },
                {
                  school_id: "school-1",
                  class_id: "class-1",
                  student_id: "other",
                  status: "active",
                  enrolled_at: "2026-06-01T00:00:00.000Z",
                  created_at: "2026-06-01T00:00:00.000Z",
                  updated_at: "2026-06-01T00:00:00.000Z",
                  withdrawn_at: null,
                },
              ],
              total: 2,
            },
          });
        }
        return Promise.resolve<unknown>({
          data: {
            enrollments: [
              {
                school_id: "school-1",
                class_id: "class-2",
                student_id: "target",
                status: "completed",
                enrolled_at: "2026-01-01T00:00:00.000Z",
                created_at: "2026-01-01T00:00:00.000Z",
                updated_at: "2026-01-01T00:00:00.000Z",
                withdrawn_at: "2026-05-01T00:00:00.000Z",
              },
            ],
            total: 1,
          },
        });
      }
      return Promise.resolve<unknown>({ data: {} });
    });

    const history = await fetchStudentEnrollmentHistory("target");

    expect(history.map((entry) => entry.class_id)).toEqual(["class-1", "class-2"]);
    expect(history[0]?.class?.code).toBe("MATH-101");
    expect(history[1]?.class?.code).toBe("SCI-101");
  });
});
