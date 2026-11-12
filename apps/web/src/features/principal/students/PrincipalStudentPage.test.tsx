import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { AuthProvider, createSessionStore } from "../../../lib/auth";

import type { SessionTokens } from "../../../lib/auth";
import type { ComponentType } from "react";

const STUDENT: Record<string, unknown> = {
  id: "student-1",
  school_id: "school-1",
  user_id: "user-1",
  first_name: "Amara",
  middle_name: null,
  last_name: "Chen",
  preferred_name: null,
  date_of_birth: null,
  nationality_country_id: null,
  // What a principal receives: admission data is masked server-side (no billing:read).
  admission_number: "",
  admission_date: null,
  status: "enrolled",
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z",
};

const PARENT: Record<string, unknown> = {
  id: "parent-1",
  school_id: "school-1",
  email: "morgan@example.edu",
  display_name: "Morgan Lee",
  status: "active",
  roles: ["PARENT"],
  email_verified_at: null,
  last_login_at: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

function recordsFor(kind: "student" | "parent", value: string | null) {
  return {
    subject_kind: kind,
    subject_id: kind === "student" ? "student-1" : "parent-1",
    template_version: 1,
    missing_required: value === null ? 1 : 0,
    entries: [
      {
        field: {
          id: kind === "student" ? "field-allergies" : "field-employer",
          field_type: "short_text",
          label_en: kind === "student" ? "Allergies" : "Employer",
          label_ar: kind === "student" ? "الحساسية" : "جهة العمل",
          help_en: null,
          help_ar: null,
          required: true,
          options: [],
          sort_order: 0,
          visibility: "teachers",
          sensitivity: "standard",
          has_expiry: false,
        },
        archived: false,
        value,
        masked: false,
        mask: null,
        answered: value !== null,
        missing: value === null,
        answered_in_version: value === null ? null : 1,
        answered_field: null,
        document: null,
        updated_at: null,
      },
    ],
  };
}

const RESULT = {
  finalization_id: "fin-1",
  academic_year_id: "year-1",
  academic_year_name: "2025–2026",
  section_name: "C",
  grade_level_name: "Grade 9",
  term_id: null,
  term_name: null,
  version: 1,
  finalized_at: "2026-06-30T10:00:00.000Z",
  result: {
    student_id: "student-1",
    first_name: "Amara",
    last_name: "Chen",
    admission_number: "",
    status: "complete",
    average_percentage: 84.5,
    total_obtained: 845,
    total_max: 1000,
    grade_label: "B+",
    subjects_failed: 1,
    academic_status: "supplementary",
    subjects: [],
  },
};
const CERTIFICATE = {
  id: "cert-1",
  kind: "annual_certificate",
  serial_number: "2026-0042",
  status: "issued",
  academic_year_id: "year-1",
  student_id: "student-1",
  finalization_id: "fin-1",
  issued_at: "2026-07-01T10:00:00.000Z",
};
const INCIDENT = {
  id: "incident-1",
  student_id: "student-1",
  incident_type: "behavioral",
  severity: "minor",
  status: "resolved",
  title: "Late to class",
  incident_at: "2026-09-10T08:00:00.000Z",
};

const TRANSCRIPT_CONTENT = {
  version: 1,
  kind: "transcript",
  serial_number: "TR-7K2M9QX4PB",
  issued_at: "2026-07-02T10:00:00.000Z",
  school: { id: "school-1", name: "Al Noor School" },
  student: { id: "student-1", first_name: "Amara", last_name: "Chen", admission_number: "" },
  years: [
    {
      academic_year: { id: "year-0", code: "2024", name: "2024–2025" },
      grade_level_name: "Grade 8",
      section_name: "B",
      finalization: { id: "fin-0", version: 1, finalized_at: "2025-06-30T10:00:00.000Z" },
      subjects: [
        {
          code: "MATH",
          name: "Mathematics",
          requirement: "mandatory",
          marks_obtained: 90,
          max_marks: 100,
          percentage: 90,
          grade_label: "A",
          gpa_points: 4,
          passed: true,
          exempt: false,
          include_in_average: true,
          average_weight: 3,
        },
      ],
      overall: {
        average_percentage: 90,
        total_obtained: 90,
        total_max: 100,
        grade_label: "A",
        subjects_failed: 0,
        academic_status: "promoted",
        // The grade shows results out of 20: 90% is 18 / 20.
        display: { format: "out_of", value: 18, max: 20 },
      },
    },
  ],
  cumulative: {
    average_percentage: 81.25,
    gpa: 3.13,
    gpa_unavailable_reason: null,
    subjects_without_gpa_points: [],
    years_covered: 2,
    subjects_counted: 3,
  },
  issued_by: { user_id: "principal-1", name: "Principal Noor" },
  reissue: null,
};
const TRANSCRIPT = {
  id: "transcript-1",
  serial_number: "TR-7K2M9QX4PB",
  status: "issued",
  student_id: "student-1",
  issued_at: "2026-07-02T10:00:00.000Z",
  supersedes_id: null,
  reissue_reason: null,
  revoked_at: null,
  revoke_reason: null,
  content_sha256: "0".repeat(64),
  needs_reissue: false,
  stale_reasons: [],
  content: TRANSCRIPT_CONTENT,
};
const TRANSCRIPT_READY = {
  state: "ready",
  reasons: [],
  current_transcript_id: null,
  years: [
    {
      academic_year_id: "year-0",
      academic_year_name: "2024–2025",
      grade_level_name: "Grade 8",
      section_name: "B",
      status: "complete",
    },
    {
      academic_year_id: "year-1",
      academic_year_name: "2025–2026",
      grade_level_name: "Grade 9",
      section_name: "C",
      status: "complete",
    },
  ],
  cumulative: TRANSCRIPT_CONTENT.cumulative,
};

let studentRecords = recordsFor("student", null);
let transcripts: (typeof TRANSCRIPT)[] = [];
/** The document GET /api/grading/transcripts/{transcriptId} answers with (TRANSCRIPT when null). */
let transcriptDocument: unknown = null;

interface RequestInit {
  params?: { path?: Record<string, string> };
  body?: { answers?: { field_id: string; value: string }[] };
}

const PARENT_SUMMARY = {
  user_id: "parent-1",
  display_name: "Morgan Lee",
  email: "morgan@example.edu",
  phone: "+965 5000 1234",
  status: "active",
  member_code: "PAR-100001",
  last_login_at: null,
  created_at: "2026-01-01T00:00:00.000Z",
  children: [
    {
      student_id: "student-1",
      first_name: "Ali",
      last_name: "Hassan",
      admission_number: null,
      relationship: "mother",
      class_label: "Grade 1 – A",
    },
  ],
};

const getMock = mock((path: string, _init?: RequestInit) => {
  if (path === "/api/students") {
    return Promise.resolve<unknown>({ data: { students: [STUDENT], next_cursor: null } });
  }
  if (path === "/api/students/{studentId}") return Promise.resolve<unknown>({ data: STUDENT });
  if (path === "/api/students/{studentId}/guardians") {
    return Promise.resolve<unknown>({
      data: [{ parent_user_id: "parent-1", relationship: "mother", family_id: "family-1" }],
    });
  }
  if (path === "/api/users/{userId}") return Promise.resolve<unknown>({ data: PARENT });
  if (path === "/api/parents/{parentUserId}")
    return Promise.resolve<unknown>({ data: PARENT_SUMMARY });
  if (path === "/api/parents") {
    return Promise.resolve<unknown>({ data: { parents: [PARENT_SUMMARY], next_cursor: null } });
  }
  if (path === "/api/students/{studentId}/records") {
    return Promise.resolve<unknown>({ data: studentRecords });
  }
  if (path === "/api/parents/{parentUserId}/records") {
    return Promise.resolve<unknown>({ data: recordsFor("parent", "Al Noor Clinic") });
  }
  if (path === "/api/grading/students/{studentId}/results") {
    return Promise.resolve<unknown>({ data: { results: [RESULT] } });
  }
  if (path === "/api/grading/students/{studentId}/certificates") {
    return Promise.resolve<unknown>({ data: { certificates: [CERTIFICATE] } });
  }
  if (path === "/api/discipline/incidents") {
    return Promise.resolve<unknown>({ data: { incidents: [INCIDENT], total: 3 } });
  }
  if (path === "/api/grading/students/{studentId}/transcript-readiness") {
    return Promise.resolve<unknown>({
      data:
        transcripts.length > 0
          ? { ...TRANSCRIPT_READY, state: "issued", current_transcript_id: "transcript-1" }
          : TRANSCRIPT_READY,
    });
  }
  if (path === "/api/grading/students/{studentId}/transcripts") {
    return Promise.resolve<unknown>({ data: { transcripts } });
  }
  if (path === "/api/grading/transcripts/{transcriptId}") {
    return Promise.resolve<unknown>({ data: transcriptDocument ?? TRANSCRIPT });
  }
  return Promise.resolve<unknown>({ data: {} });
});

const postMock = mock((path: string, _init?: RequestInit) => {
  if (path === "/api/grading/students/{studentId}/transcripts") {
    transcripts = [TRANSCRIPT];
    return Promise.resolve<unknown>({ data: TRANSCRIPT });
  }
  return Promise.resolve<unknown>({ data: {} });
});

const putMock = mock((path: string, init?: RequestInit) => {
  if (path === "/api/students/{studentId}/records") {
    studentRecords = recordsFor("student", init?.body?.answers?.[0]?.value ?? null);
    return Promise.resolve<unknown>({ data: studentRecords });
  }
  return Promise.resolve<unknown>({ data: {} });
});

mock.module("../../../lib/api", () => ({
  api: { GET: getMock, PUT: putMock, POST: postMock, PATCH: mock(), DELETE: mock() },
}));

function fakeJwt(payload: unknown): string {
  const segment = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${segment({ alg: "RS256" })}.${segment(payload)}.signature`;
}

async function renderAsPrincipal(url: string) {
  const [StudentsPage, StudentPage, ParentPage, ParentsPage, TranscriptPage] = (await Promise.all([
    import("./PrincipalStudentsPage"),
    import("./PrincipalStudentPage"),
    import("./PrincipalParentPage"),
    import("../../records/parents/ParentDirectoryPage"),
    import("./transcripts/TranscriptPage"),
  ]).then((modules) => modules.map((module) => module.default))) as ComponentType[];
  const store = createSessionStore({
    refreshClient: {
      refresh: async (): Promise<SessionTokens> => ({
        accessToken: fakeJwt({ roles: ["PRINCIPAL"] }),
        expiresAt: Date.now() + 3_600_000,
        sessionId: "session-1",
      }),
      logout: async () => undefined,
    },
  });
  await store.restore();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <AuthProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <MemoryRouter initialEntries={[url]}>
            <Routes>
              <Route path="/portal/principal/students" element={<StudentsPage />} />
              <Route path="/portal/principal/students/:studentId" element={<StudentPage />} />
              <Route path="/portal/principal/parents" element={<ParentsPage />} />
              <Route path="/portal/principal/parents/:parentUserId" element={<ParentPage />} />
              <Route
                path="/portal/principal/students/:studentId/transcripts/:transcriptId"
                element={<TranscriptPage />}
              />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>
    </AuthProvider>,
  );
}

afterEach(() => {
  cleanup();
  studentRecords = recordsFor("student", null);
  transcripts = [];
  transcriptDocument = null;
  getMock.mockClear();
  putMock.mockClear();
  postMock.mockClear();
});

describe("Principal > Students", () => {
  test("a principal opens a student from the roll and fills in their record", async () => {
    await renderAsPrincipal("/portal/principal/students");

    fireEvent.click(await screen.findByRole("link", { name: "Amara Chen" }));
    expect(await screen.findByRole("heading", { name: "Amara Chen" })).toBeTruthy();
    // Read-only on everything else: no admission data on the page.
    expect(screen.queryByText(/Admission/)).toBeNull();

    const records = await screen.findByRole("region", { name: "Records" });
    expect(within(records).getByText("1 required field is missing")).toBeTruthy();
    fireEvent.click(within(records).getByRole("button", { name: "Edit record" }));
    fireEvent.change(within(records).getByLabelText(/Allergies/), { target: { value: "Peanuts" } });
    fireEvent.click(within(records).getByRole("button", { name: "Save record" }));

    await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
    const [path, init] = putMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/students/{studentId}/records");
    expect(init.params?.path).toEqual({ studentId: "student-1" });
    expect(init.body).toEqual({ answers: [{ field_id: "field-allergies", value: "Peanuts" }] });
    expect(await within(records).findByText("Peanuts")).toBeTruthy();
  });

  test("each guardian opens that parent's record", async () => {
    await renderAsPrincipal("/portal/principal/students/student-1");

    fireEvent.click(await screen.findByRole("link", { name: "Open Morgan Lee's records" }));
    expect(await screen.findByRole("heading", { name: "Morgan Lee: records" })).toBeTruthy();
    expect(await screen.findByText("Al Noor Clinic")).toBeTruthy();
    // The principal (user:read) sees how to reach the parent, and their children.
    const details = await screen.findByRole("region", { name: "Contact details" });
    expect(await within(details).findByText("+965 5000 1234")).toBeTruthy();
    expect(within(details).getByText("PAR-100001")).toBeTruthy();
    expect(within(details).getByRole("link", { name: "Ali Hassan (Grade 1 – A)" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back" }).getAttribute("href")).toBe(
      "/portal/principal/students/student-1",
    );
  });
  test("Parents lists every parent with their phone, children and Studafy ID", async () => {
    await renderAsPrincipal("/portal/principal/parents");

    const link = await screen.findByRole("link", { name: "Morgan Lee" });
    expect(link.getAttribute("href")).toBe("/portal/principal/parents/parent-1");
    expect(screen.getByText("+965 5000 1234")).toBeTruthy();
    expect(screen.getByText("Ali Hassan (Grade 1 – A) · Mother")).toBeTruthy();
    expect(screen.getByText("PAR-100001")).toBeTruthy();
  });

  test("the student page sums up results, certificates, discipline and attendance", async () => {
    await renderAsPrincipal("/portal/principal/students/student-1");

    const results = await screen.findByRole("region", { name: "Results" });
    expect(await within(results).findByText("Whole year 2025–2026")).toBeTruthy();
    expect(within(results).getByText("B+")).toBeTruthy();
    expect(within(results).getByText(/1 subject failed/)).toBeTruthy();

    const certificates = screen.getByRole("region", { name: "Report cards & certificates" });
    expect(
      (
        await within(certificates).findByRole("link", { name: /^Certificate 2026-0042/ })
      ).getAttribute("href"),
    ).toBe("/portal/principal/academic-setup/certificates/cert-1?year=year-1");

    const discipline = screen.getByRole("region", { name: "Discipline" });
    expect(await within(discipline).findByRole("link", { name: "Late to class" })).toBeTruthy();
    expect(within(discipline).getByText("And 2 older incidents.")).toBeTruthy();
    expect(getMock).toHaveBeenCalledWith("/api/discipline/incidents", {
      params: { query: { student_id: "student-1", limit: 10, offset: 0 } },
    });

    expect(
      screen
        .getByRole("link", { name: "Open this student's attendance history" })
        .getAttribute("href"),
    ).toBe("/portal/attendance/students/student-1");
  });

  test("a principal sees what a transcript would cover and issues it", async () => {
    await renderAsPrincipal("/portal/principal/students/student-1");

    const panel = await screen.findByRole("region", { name: "Transcript" });
    expect(await within(panel).findByText("Ready to issue")).toBeTruthy();
    expect(
      within(panel).getByText("Covers 2 years: Grade 8 (2024–2025), Grade 9 (2025–2026)."),
    ).toBeTruthy();
    expect(within(panel).getByText("81.25%")).toBeTruthy();
    expect(within(panel).getByText("3.13")).toBeTruthy();
    expect(within(panel).getByText("No transcript issued yet.")).toBeTruthy();

    fireEvent.click(within(panel).getByRole("button", { name: "Issue transcript" }));
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    const [path, init] = postMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/grading/students/{studentId}/transcripts");
    expect(init.params?.path).toEqual({ studentId: "student-1" });
    const link = await within(panel).findByRole("link", { name: /^Transcript TR-7K2M9QX4PB/ });
    expect(link.getAttribute("href")).toBe(
      "/portal/principal/students/student-1/transcripts/transcript-1",
    );
    expect(await within(panel).findByText("Issued and up to date")).toBeTruthy();
  });

  test("the transcript prints every year and the cumulative figures as issued", async () => {
    await renderAsPrincipal("/portal/principal/students/student-1/transcripts/transcript-1");

    const document = await screen.findByRole("article", { name: "Academic Transcript" });
    expect(within(document).getByText("Al Noor School")).toBeTruthy();
    expect(within(document).getByText("TR-7K2M9QX4PB")).toBeTruthy();
    expect(within(document).getByRole("heading", { name: "2024–2025 — Grade 8, B" })).toBeTruthy();
    expect(within(document).getByRole("rowheader", { name: "Mathematics" })).toBeTruthy();
    expect(within(document).getByText("18 / 20")).toBeTruthy();
    expect(within(document).getByText("81.25%")).toBeTruthy();
    expect(within(document).getByText("3.13")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Print" })).toBeTruthy();
  });

  test("a transcript lists a descriptive subject's skills and explains a GPA it cannot give", async () => {
    const [year] = TRANSCRIPT_CONTENT.years;
    transcriptDocument = {
      ...TRANSCRIPT,
      content: {
        ...TRANSCRIPT_CONTENT,
        years: [
          {
            ...year!,
            subjects: [
              ...year!.subjects,
              {
                code: "RD",
                name: "Reading",
                requirement: "mandatory",
                marks_obtained: null,
                max_marks: 100,
                percentage: null,
                grade_label: "Very good",
                gpa_points: null,
                passed: true,
                exempt: false,
                include_in_average: false,
                average_weight: 1,
                descriptive: true,
                skills: [
                  {
                    name: "Reads fluently",
                    category_name: "Reading",
                    descriptor_label: "Excellent",
                  },
                ],
              },
            ],
          },
        ],
        cumulative: {
          ...TRANSCRIPT_CONTENT.cumulative,
          gpa: null,
          gpa_unavailable_reason: "mixed_gpa_scales",
          gpa_scale_max: null,
          mixed_gpa_scales: [
            { academic_year_name: "2024–2025", max: 4 },
            { academic_year_name: "2025–2026", max: 5 },
          ],
        },
      },
    };
    await renderAsPrincipal("/portal/principal/students/student-1/transcripts/transcript-1");

    const document = await screen.findByRole("article", { name: "Academic Transcript" });
    const reading = within(document).getByRole("rowheader", { name: /^Reading/ });
    expect(within(reading).getByText("Reads fluently: Excellent")).toBeTruthy();
    expect(within(document).getByText("Very good")).toBeTruthy();
    expect(
      within(document).getByText(
        "No cumulative GPA: the years use different GPA scales (2024–2025: out of 4, 2025–2026: out of 5), so their points can't be averaged.",
      ),
    ).toBeTruthy();
  });
});
