import { ApiError } from "@studafy/api-client";
import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { AuthProvider } from "../../../lib/auth";
import { expectNoA11yViolations } from "../../../lib/test/axe";
import { createTestSessionStore } from "../../../lib/test/session";

import type { ComponentType } from "react";

/**
 * Academic setup: a section's subjects show where each comes from (inherited vs override vs
 * excluded) with outdated-override actions; the subject editor checks weight totals live; a save
 * that would recalculate recorded marks shows its impact and is resent only once confirmed; and a
 * blocked student's certificate readiness lists why.
 */

const STAMP = { created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z" };
const YEAR = {
  id: "year-1",
  school_id: "school-1",
  code: "2026",
  name: "2026-2027",
  status: "active",
  starts_on: "2026-09-01",
  ends_on: "2027-06-30",
  ...STAMP,
};
const TERMS = [
  {
    id: "term-1",
    name: "Term 1",
    sequence_number: 1,
    starts_on: "2026-09-01",
    ends_on: "2027-01-31",
  },
  {
    id: "term-2",
    name: "Term 2",
    sequence_number: 2,
    starts_on: "2027-02-01",
    ends_on: "2027-06-30",
  },
].map((term) => ({
  ...term,
  school_id: "school-1",
  academic_year_id: "year-1",
  code: term.id,
  status: "active",
  ...STAMP,
}));
const GRADE_10 = {
  id: "grade-10",
  school_id: "school-1",
  name: "Grade 10",
  sort_order: 10,
  ...STAMP,
};
const SECTION_10C = {
  id: "sec-10c",
  school_id: "school-1",
  academic_year_id: "year-1",
  grade_level_id: "grade-10",
  grade_level_name: "Grade 10",
  name: "C",
  student_count: 1,
  ...STAMP,
};
const OVERVIEW = {
  year: { id: "year-1", code: "2026", name: "2026-2027", grading_config_status: "active" },
  grades: [],
  counts: {
    grades: 1,
    subjects_invalid: 0,
    sections: 1,
    sections_with_overrides: 1,
    outdated_overrides: 1,
    missing_teacher_assignments: 0,
    students_with_incomplete_marks: 0,
    mark_sheets_awaiting_approval: 0,
    proposed_assessments: 0,
    certificates_ready: 0,
    certificates_blocked: 0,
    certificates_needing_reissue: 0,
  },
  issues: [],
};
const SECTION_SUBJECTS = {
  section: {
    id: "sec-10c",
    name: "C",
    academic_year_id: "year-1",
    grade_level_id: "grade-10",
    grade_level_name: "Grade 10",
  },
  subjects: [
    {
      subject_id: "sub-math",
      subject_code: "MATH",
      subject_name: "Mathematics",
      source: "inherited",
      config_id: "cfg-math",
      grade_config_id: "cfg-math",
      override_config_id: null,
      requirement: "mandatory",
      outdated: false,
      grade_revision: 1,
      based_on_revision: null,
      teachers: [{ teacher_id: "t-1", name: "Rana Saleh", assignment_id: "as-1" }],
    },
    {
      subject_id: "sub-sci",
      subject_code: "SCI",
      subject_name: "Science",
      source: "override",
      config_id: "cfg-sci-c",
      grade_config_id: "cfg-sci",
      override_config_id: "cfg-sci-c",
      requirement: "mandatory",
      outdated: true,
      grade_revision: 3,
      based_on_revision: 2,
      teachers: [{ teacher_id: "t-2", name: "Omar Aziz", assignment_id: null }],
    },
    {
      subject_id: "sub-art",
      subject_code: "ART",
      subject_name: "Art",
      source: "excluded",
      config_id: null,
      grade_config_id: "cfg-art",
      override_config_id: "cfg-art-c",
      requirement: "optional",
      outdated: false,
      grade_revision: 1,
      based_on_revision: 1,
      teachers: [],
    },
  ],
};
/** A valid weighted configuration: one term category at 100%, terms 50/50, one exam per term. */
const MATH_CONFIG = {
  id: "cfg-math",
  academic_year_id: "year-1",
  grade_level_id: "grade-10",
  section_id: null,
  subject: { id: "sub-math", code: "MATH", name: "Mathematics" },
  requirement: "mandatory",
  include_in_average: true,
  include_on_certificate: true,
  average_weight: 1,
  grading_method: "weighted",
  max_marks: 100,
  pass_percentage: 50,
  final_exam_pass_percentage: null,
  grade_scale_id: null,
  effective_scale_name: null,
  rounding_decimals: 2,
  rounding_mode: "half_up",
  missing_mark_policy: "incomplete",
  absent_policy: "incomplete",
  retake_policy: "none",
  retake_cap_percentage: null,
  teachers_can_add_assessments: false,
  teacher_assessments_require_approval: true,
  instructions: null,
  is_excluded: false,
  revision: 1,
  based_on_revision: null,
  term_weights: [
    { term_id: "term-1", term_name: "Term 1", sequence_number: 1, weight: 50 },
    { term_id: "term-2", term_name: "Term 2", sequence_number: 2, weight: 50 },
  ],
  categories: [
    {
      id: "cat-exams",
      name: "Exams",
      kind: "exam",
      scope: "term",
      weight: 100,
      aggregation: "weighted_average",
      drop_lowest: 0,
      sort_order: 0,
    },
  ],
  assessments: ["term-1", "term-2"].map((termId, index) => ({
    id: `asm-${termId}`,
    category_id: "cat-exams",
    term_id: termId,
    section_id: null,
    name: `Exam ${index + 1}`,
    max_marks: 100,
    weight: 1,
    is_mandatory: true,
    assessment_date: null,
    due_date: null,
    status: "active",
    sort_order: index,
    mark_count: 6,
  })),
  weight_summary: { termCategoryTotal: 100, annualTotal: 100, valid: true },
  issues: [],
  valid: true,
  mark_count: 12,
  updated_at: "2026-10-01T00:00:00.000Z",
};
const IMPACT = {
  config_id: "cfg-math",
  is_grade_default: true,
  revision: 1,
  mark_count: 12,
  inheriting_sections: [{ section_id: "sec-10c", name: "C", mark_count: 12 }],
  overriding_sections: [
    {
      section_id: "sec-10d",
      name: "D",
      config_id: "cfg-math-d",
      excluded: false,
      based_on_revision: 1,
      outdated: false,
    },
  ],
  finalized_sections: [{ section_id: "sec-10a", name: "A", term_id: "term-1" }],
};
const FINALIZATION = {
  id: "fin-1",
  academic_year_id: "year-1",
  section_id: "sec-10c",
  term_id: null,
  version: 1,
  status: "finalized",
  finalized_by_user_id: "user-1",
  finalized_at: "2027-06-30T10:00:00.000Z",
  supersedes_id: null,
  correction_reason: null,
  superseded_at: null,
};

function studentResult(id: string, first: string, status: "complete" | "incomplete") {
  return {
    student_id: id,
    first_name: first,
    last_name: "Haddad",
    admission_number: `ADM-${id}`,
    status,
    average_percentage: status === "complete" ? 81.5 : null,
    total_obtained: status === "complete" ? 81.5 : null,
    total_max: status === "complete" ? 100 : null,
    grade_label: status === "complete" ? "B" : null,
    subjects_failed: 0,
    academic_status: status === "complete" ? "promoted" : "incomplete",
    subjects: [],
  };
}

const GET_RESPONSES: Record<string, unknown> = {
  "/api/academics/years": { academic_years: [YEAR], total: 1 },
  "/api/academics/years/{yearId}/terms": { terms: TERMS, total: TERMS.length },
  "/api/academics/grade-levels": { grade_levels: [GRADE_10], total: 1 },
  "/api/academics/sections": { sections: [SECTION_10C], total: 1 },
  "/api/academics/subjects": { subjects: [], total: 0 },
  "/api/academics/sections/{sectionId}/students": { students: [], total: 0 },
  "/api/grading/years/{yearId}/overview": OVERVIEW,
  "/api/grading/years/{yearId}/scales": { scales: [] },
  "/api/grading/years/{yearId}/programs": {
    programs: [
      {
        id: "prog-10",
        academic_year_id: "year-1",
        grade_level_id: "grade-10",
        grade_level_name: "Grade 10",
        grade_scale_id: null,
        max_failed_subjects_for_supplementary: 2,
        mark_approval_required: false,
        average_rounding_decimals: 2,
        average_rounding_mode: "half_up",
        updated_at: "2026-10-01T00:00:00.000Z",
      },
    ],
  },
  "/api/grading/years/{yearId}/programs/{gradeLevelId}/subjects": { configs: [MATH_CONFIG] },
  "/api/grading/subject-configs/{configId}": MATH_CONFIG,
  "/api/grading/subject-configs/{configId}/impact": IMPACT,
  "/api/grading/sections/{sectionId}/subjects": SECTION_SUBJECTS,
  "/api/grading/sections/{sectionId}/subject-enrollments": { enrollments: [] },
  "/api/grading/finalizations": {
    finalizations: [
      { ...FINALIZATION, section_name: "C", grade_level_name: "Grade 10", term_name: null },
    ],
  },
  "/api/grading/finalizations/{finalizationId}": {
    finalization: FINALIZATION,
    results: [studentResult("s-1", "Lina", "complete"), studentResult("s-2", "Sami", "incomplete")],
  },
  "/api/grading/finalizations/{finalizationId}/certificates/readiness": {
    students: [
      {
        student_id: "s-1",
        first_name: "Lina",
        last_name: "Haddad",
        state: "ready",
        reasons: [],
        certificate_id: null,
      },
      {
        student_id: "s-2",
        first_name: "Sami",
        last_name: "Haddad",
        state: "blocked",
        reasons: ["Mathematics is incomplete: Exam 2 has no mark."],
        certificate_id: null,
      },
    ],
  },
  "/api/grading/certificates": { certificates: [] },
  "/api/grading/years/{yearId}/proposed-assessments": { assessments: [] },
  "/api/grading/years/{yearId}/mark-sheets": {
    sheets: [
      {
        id: "sheet-1",
        section_id: "sec-10c",
        subject_id: "sub-sci",
        term_id: "term-1",
        status: "submitted",
        submitted_by_user_id: "user-2",
        submitted_at: "2026-12-01T09:00:00.000Z",
        decided_by_user_id: null,
        decided_at: null,
        return_reason: null,
        updated_at: "2026-12-01T09:00:00.000Z",
        section_name: "C",
        grade_level_name: "Grade 10",
        subject_name: "Science",
        term_name: "Term 1",
        submitted_by_name: "Omar Aziz",
      },
    ],
  },
};

const RESPONSES_BY_PATH = new Map(Object.entries(GET_RESPONSES));
const getMock = mock((path: string, _init?: unknown) =>
  Promise.resolve<unknown>({ data: RESPONSES_BY_PATH.get(path) }),
);
const postMock = mock((path: string, _init?: unknown) => {
  if (path === "/api/grading/finalizations/{finalizationId}/certificates") {
    return Promise.resolve<unknown>({ data: { issued: ["cert-1"], skipped: [] } });
  }
  return Promise.resolve<unknown>({ data: MATH_CONFIG });
});
const putMock = mock((_path: string, _init?: unknown) =>
  Promise.resolve<unknown>({ data: { config: MATH_CONFIG, affected_section_ids: [] } }),
);
const deleteMock = mock((_path: string, _init?: unknown) =>
  Promise.resolve<unknown>({ data: undefined }),
);
mock.module("../../../lib/api", () => ({
  api: { GET: getMock, POST: postMock, PUT: putMock, DELETE: deleteMock },
}));

async function renderAt(tab: string) {
  const Page: ComponentType = (await import("./AcademicSetupPage")).default;
  const store = await createTestSessionStore(["PRINCIPAL"]);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <AuthProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <MemoryRouter initialEntries={[`/portal/principal/academic-setup${tab}?year=year-1`]}>
            <main>
              <Routes>
                <Route path="/portal/principal/academic-setup/*" element={<Page />} />
              </Routes>
            </main>
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>
    </AuthProvider>,
  );
}

function rowOf(text: string): HTMLElement {
  const row = screen.getByText(text).closest("tr");
  if (!row) throw new Error(`No table row contains "${text}"`);
  return row;
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
  postMock.mockClear();
  putMock.mockReset();
  putMock.mockImplementation(() =>
    Promise.resolve<unknown>({ data: { config: MATH_CONFIG, affected_section_ids: [] } }),
  );
  deleteMock.mockClear();
});

describe("AcademicSetupPage", () => {
  test("tells inherited, overridden and excluded section subjects apart, and keeps an outdated override", async () => {
    await renderAt("/sections");

    expect(await screen.findByText("Mathematics")).toBeTruthy();
    expect(within(rowOf("Mathematics")).getByText("Inherited from grade")).toBeTruthy();
    const science = rowOf("Science");
    expect(within(science).getByText("Section override")).toBeTruthy();
    expect(within(science).queryByText("Inherited from grade")).toBeNull();
    expect(within(rowOf("Art")).getByText("Not offered")).toBeTruthy();

    // The grade default moved on after Science was overridden: offer both ways forward.
    expect(within(science).getByText("Outdated")).toBeTruthy();
    expect(
      within(science).getByRole("button", { name: "Accept the grade default for Science" }),
    ).toBeTruthy();
    fireEvent.click(within(science).getByRole("button", { name: "Keep the override for Science" }));
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith("/api/grading/subject-configs/{configId}/keep", {
        params: { path: { configId: "cfg-sci-c" } },
      }),
    );

    // An inherited subject can be customized or excluded; it has no outdated actions.
    const math = rowOf("Mathematics");
    expect(
      within(math).getByRole("button", { name: "Customize Mathematics for this section" }),
    ).toBeTruthy();
    expect(within(math).queryByText("Outdated")).toBeNull();
  });

  test("checks the weight totals live as the rules are edited", async () => {
    await renderAt("/subjects");

    fireEvent.click(await screen.findByRole("button", { name: "Edit Mathematics" }));
    const category = await screen.findByRole("group", { name: "Category: Exams" });
    expect(screen.getByText("Weights add up.")).toBeTruthy();
    expect(screen.getByText("Term categories total 100% of 100%")).toBeTruthy();

    fireEvent.change(within(category).getByRole("spinbutton", { name: "Weight" }), {
      target: { value: "90" },
    });

    expect(await screen.findByText("Term categories total 90% of 100%")).toBeTruthy();
    expect(screen.getByText("Term category weights total 90%; they must total 100%.")).toBeTruthy();
    expect(screen.getByText("Weights don't add up yet.")).toBeTruthy();
    // The year is published, so a configuration with errors cannot be saved.
    expect(
      screen.getByText("The year is published, so these problems must be fixed before saving."),
    ).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("shows the impact of a change to recorded marks and resends the save only once confirmed", async () => {
    putMock.mockImplementationOnce(() =>
      Promise.reject(
        new ApiError({
          status: 409,
          title: "Conflict",
          code: "ACADEMIC_CONFIG_IMPACT_UNCONFIRMED",
          detail: "12 recorded marks in C will be recalculated under the new rules.",
          instance: null,
          type: null,
          request_id: null,
          problem: null,
        }),
      ),
    );
    await renderAt("/subjects");

    fireEvent.click(await screen.findByRole("button", { name: "Edit Mathematics" }));
    const editor = await screen.findByRole("region", { name: "Mathematics grading rules" });
    fireEvent.change(within(editor).getByRole("spinbutton", { name: "Pass percentage" }), {
      target: { value: "60" },
    });
    fireEvent.click(within(editor).getByRole("button", { name: "Save" }));

    const dialog = await screen.findByRole("dialog", {
      name: "This change recalculates recorded marks",
    });
    expect(
      await within(dialog).findByText(
        "12 recorded marks will be recalculated under the new rules.",
      ),
    ).toBeTruthy();
    expect(within(dialog).getByText("Affected: sections using these rules")).toBeTruthy();
    expect(within(dialog).getByText("Not affected: sections with their own override")).toBeTruthy();
    expect(within(dialog).getByText("A — Term 1")).toBeTruthy();
    expect(putMock).toHaveBeenCalledTimes(1);
    const firstBody = (putMock.mock.calls[0]?.[1] as { body: Record<string, unknown> }).body;
    expect(firstBody.confirm_impact).toBe(false);
    expect(firstBody.pass_percentage).toBe(60);
    // Existing categories and assessments are sent by id, so their marks stay attached.
    expect((firstBody.categories as { ref: string }[])[0]?.ref).toBe("cat-exams");
    expect((firstBody.assessments as { id?: string }[]).map((a) => a.id)).toEqual([
      "asm-term-1",
      "asm-term-2",
    ]);

    fireEvent.click(within(dialog).getByRole("button", { name: "Recalculate and save" }));
    await waitFor(() => expect(putMock).toHaveBeenCalledTimes(2));
    const secondBody = (putMock.mock.calls[1]?.[1] as { body: Record<string, unknown> }).body;
    expect(secondBody.confirm_impact).toBe(true);
    expect(await screen.findByText("Grading rules saved")).toBeTruthy();
  });

  test("lists why a student's certificate is blocked and issues one to a ready student", async () => {
    await renderAt("/results");

    const blocked = await screen.findByText("Mathematics is incomplete: Exam 2 has no mark.");
    const row = blocked.closest("tr")!;
    expect(within(row).getByText("Sami Haddad")).toBeTruthy();
    expect(within(row).getByText("Blocked")).toBeTruthy();
    expect(within(row).queryByRole("button", { name: /Issue/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Issue a certificate to Lina Haddad" }));
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith(
        "/api/grading/finalizations/{finalizationId}/certificates",
        { params: { path: { finalizationId: "fin-1" } }, body: { student_ids: ["s-1"] } },
      ),
    );
  });

  test("shows the year's status, readiness counts and the set-up checklist", async () => {
    await renderAt("");

    expect(await screen.findByRole("heading", { name: /Grading for 2026-2027/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Finalize year" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Outdated overrides/ }).getAttribute("href")).toBe(
      "/portal/principal/academic-setup/sections?year=year-1",
    );
    expect(screen.getByText("Set up grades and a grading scale")).toBeTruthy();
    expect(screen.getByText("No issues found.")).toBeTruthy();
  });

  test("returns a submitted mark sheet to its teacher with a reason", async () => {
    await renderAt("/approvals");

    fireEvent.click(
      await screen.findByRole("button", { name: "Return Science, Grade 10 – C to the teacher" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Return Science, Grade 10 – C?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Return" }));
    expect(await within(dialog).findByText("Give a reason.")).toBeTruthy();
    expect(postMock).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByRole("textbox", { name: /Reason/ }), {
      target: { value: "Exam 2 marks are missing." },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Return" }));
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith("/api/grading/mark-sheets/{sheetId}/decision", {
        params: { path: { sheetId: "sheet-1" } },
        body: { action: "return", reason: "Exam 2 marks are missing." },
      }),
    );
  });

  test("has no accessibility violations on the sections screen", async () => {
    const { container } = await renderAt("/sections");
    await screen.findByText("Mathematics");
    await expectNoA11yViolations(container);
  });
});
