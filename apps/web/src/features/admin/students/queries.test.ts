// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";

interface RequestInit {
  params?: { path?: Record<string, string>; query?: Record<string, unknown> };
}

const getMock = mock((_path: string, _init?: RequestInit) =>
  Promise.resolve<unknown>({ data: {} }),
);

mock.module("../../../lib/api", () => ({ api: { GET: getMock } }));
mock.module("../../../lib/auth", () => ({
  sessionStore: { getToken: async () => "test-token" },
}));

/** Minimal fake standing in for the real `XMLHttpRequest`, used only by `uploadStudentImportCsv`
 * (raw XHR, not the typed `api` client — see that function's doc for why). */
class FakeXhr {
  static nextStatus = 201;
  static nextResponseBody: unknown = { id: "import-1" };
  static requests: { url: string; headers: Record<string, string> }[] = [];

  status = 0;
  response = "";
  private headers: Record<string, string> = {};
  private url = "";
  upload: {
    onprogress:
      ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null;
  } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  open(_method: string, url: string) {
    this.url = url;
  }
  setRequestHeader(key: string, value: string) {
    // eslint-disable-next-line security/detect-object-injection -- test double; `key` is a header name this same test file passes in, not untrusted input
    this.headers[key] = value;
  }
  getAllResponseHeaders() {
    return "content-type: application/json\r\n";
  }
  send(_body: unknown) {
    FakeXhr.requests.push({ url: this.url, headers: this.headers });
    setTimeout(() => {
      this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 2 });
      this.upload.onprogress?.({ lengthComputable: true, loaded: 2, total: 2 });
      this.status = FakeXhr.nextStatus;
      this.response = JSON.stringify(FakeXhr.nextResponseBody);
      this.onload?.();
    }, 0);
  }
}
// @ts-expect-error -- test double, not a full XMLHttpRequest implementation
globalThis.XMLHttpRequest = FakeXhr;

const {
  fetchStudentEnrollmentHistory,
  fetchStudentImportTemplate,
  fetchStudentsInClass,
  uploadStudentImportCsv,
} = await import("./queries");

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

describe("fetchStudentImportTemplate", () => {
  test("returns the CSV body from the typed client", async () => {
    getMock.mockImplementation((path: string) => {
      if (path === "/api/imports/students/template") {
        return Promise.resolve<unknown>({ data: "admission_number,email\n" });
      }
      return Promise.resolve<unknown>({ data: {} });
    });

    expect(await fetchStudentImportTemplate()).toBe("admission_number,email\n");
  });
});

describe("uploadStudentImportCsv", () => {
  afterEach(() => {
    FakeXhr.nextStatus = 201;
    FakeXhr.nextResponseBody = { id: "import-1" };
    FakeXhr.requests = [];
  });

  test("sends the file as raw text/csv, with the auth token and filename attached", async () => {
    const file = new File(["a,b\n1,2"], "roster.csv", { type: "text/csv" });

    await uploadStudentImportCsv(file);

    expect(FakeXhr.requests).toHaveLength(1);
    const [request] = FakeXhr.requests;
    expect(request?.url).toContain("/api/imports/students/upload");
    expect(request?.headers["Content-Type"]).toBe("text/csv");
    expect(request?.headers["X-File-Name"]).toBe("roster.csv");
    expect(request?.headers.Authorization).toBe("Bearer test-token");
  });

  test("reports upload progress as it streams", async () => {
    const file = new File(["a,b\n1,2"], "roster.csv", { type: "text/csv" });
    const events: number[] = [];

    await uploadStudentImportCsv(file, (progress) => events.push(progress.percent));

    expect(events).toEqual([50, 100]);
  });

  test("resolves with the parsed import record on a 2xx response", async () => {
    FakeXhr.nextResponseBody = { id: "import-42", status: "validated" };
    const file = new File(["a,b\n1,2"], "roster.csv", { type: "text/csv" });

    const record = await uploadStudentImportCsv(file);

    expect(record.id).toBe("import-42");
  });

  test("rejects with an ApiError built from the failed response", async () => {
    FakeXhr.nextStatus = 400;
    FakeXhr.nextResponseBody = {
      title: "Bad request",
      status: 400,
      code: "IMPORT_ROWS_EXCEED_LIMIT",
    };
    const file = new File(["a,b\n1,2"], "roster.csv", { type: "text/csv" });

    await expect(uploadStudentImportCsv(file)).rejects.toMatchObject({
      status: 400,
      code: "IMPORT_ROWS_EXCEED_LIMIT",
    });
  });
});
