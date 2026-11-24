import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { AuthProvider } from "../../../lib/auth";
import * as realCsv from "../../../lib/csv";
import { expectNoA11yViolations } from "../../../lib/test/axe";
import { createTestSessionStore } from "../../../lib/test/session";

import type { ComponentType, ReactNode } from "react";

/**
 * Academic setup's Tawjihi equivalency and multi-year results: rule sets labelled as estimates,
 * starting one from an example (marked as an example, exams picked from the catalogue), the
 * grade-level list with its CSV, the multi-year editor's checks, and the student page's panels.
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
const GRADE_11 = {
  id: "grade-11",
  school_id: "school-1",
  name: "Grade 11",
  sort_order: 11,
  ...STAMP,
};
const GRADE_12 = {
  id: "grade-12",
  school_id: "school-1",
  name: "Grade 12",
  sort_order: 12,
  ...STAMP,
};
const OVERVIEW = {
  year: { id: "year-1", code: "2026", name: "2026-2027", grading_config_status: "active" },
  grades: [],
  counts: {},
  issues: [],
};
const SAT = {
  id: "exam-sat",
  code: "SAT",
  name: "SAT",
  preset_key: "sat",
  total_mode: "sum",
  total_rounding_step: null,
  total_min: 400,
  total_max: 1600,
  per_subject: false,
  show_on_transcript: false,
  archived_at: null,
  result_count: 0,
  components: [],
  ...STAMP,
};
const PART = {
  weight: 100,
  required: true,
  exam_ids: [],
  best_count: null,
  min_count: null,
  required_subject_ids: [],
  grade_percentages: [],
  conversion: null,
  require_awarded: false,
  gpa_basis: null,
};
const IGCSE_SET = {
  id: "set-1",
  name: "IGCSE equivalency",
  source_system: "igcse_a_level",
  grade_levels: [{ id: "grade-12", name: "Grade 12" }],
  is_active: true,
  visible_to_students_and_parents: true,
  parts: [
    {
      ...PART,
      type: "exam_subjects",
      label: "IGCSE subjects",
      exam_ids: ["exam-igcse"],
      best_count: 2,
      grade_percentages: [
        { grade: "A*", percentage: 98 },
        { grade: "A", percentage: 93 },
      ],
    },
  ],
  exams: [{ id: "exam-igcse", code: "IGCSE", name: "IGCSE" }],
  subjects: [],
  ...STAMP,
};
const ESTIMATE = {
  status: "estimated",
  percentage: 95.5,
  parts: [
    {
      index: 0,
      type: "exam_subjects",
      label: "IGCSE subjects",
      weight: 100,
      required: true,
      status: "counted",
      percentage: 95.5,
      share: 100,
      source_value: null,
      source_max: null,
      subjects: [
        {
          subject: { id: "math", code: "MATH", name: "Mathematics" },
          exam: { id: "exam-igcse", code: "IGCSE", name: "IGCSE" },
          grade: "A*",
          percentage: 98,
          counted: true,
          required_subject: false,
        },
        {
          subject: { id: "arabic", code: "AR", name: "Arabic" },
          exam: { id: "exam-igcse", code: "IGCSE", name: "IGCSE" },
          grade: "A",
          percentage: 93,
          counted: true,
          required_subject: false,
        },
      ],
    },
  ],
  issues: [],
};
const INCOMPLETE = {
  status: "incomplete",
  percentage: null,
  parts: [{ ...ESTIMATE.parts[0], status: "missing", percentage: null, share: null, subjects: [] }],
  issues: [
    {
      code: "NO_EXAM_RESULTS",
      kind: "missing",
      part_index: 0,
      subject: null,
      exam: null,
      grade: null,
      required: null,
      actual: null,
    },
  ],
};
const LIST = {
  set_id: "set-1",
  academic_year_id: "year-1",
  grade_level_id: "grade-12",
  applies_to_grade_level: true,
  students: [
    {
      student_id: "stu-1",
      first_name: "Amal",
      last_name: "Haddad",
      admission_number: "A-1",
      section_name: "12A",
      ...ESTIMATE,
    },
    {
      student_id: "stu-2",
      first_name: "Badr",
      last_name: "Nasser",
      admission_number: "A-2",
      section_name: "12A",
      ...INCOMPLETE,
    },
  ],
};
const CONFIG = {
  id: "cfg-1",
  name: "Tawjihi two years",
  is_active: true,
  visible_to_students_and_parents: false,
  years: [
    { grade_level: { id: "grade-11", name: "Grade 11" }, weight: 40 },
    { grade_level: { id: "grade-12", name: "Grade 12" }, weight: 60 },
  ],
  ...STAMP,
};

const GET_RESPONSES = new Map<string, unknown>(
  Object.entries({
    "/api/grading/equivalency-rule-sets": { sets: [IGCSE_SET] },
    "/api/grading/equivalency-rule-sets/{setId}/students": LIST,
    "/api/grading/multi-year-result-configs": { configs: [CONFIG] },
    "/api/grading/external-exams": { exams: [SAT] },
    "/api/grading/students/{studentId}/equivalency": {
      student_id: "stu-1",
      grade_level: { id: "grade-12", name: "Grade 12" },
      current_year_pending: true,
      estimates: [
        {
          set: {
            id: "set-1",
            name: "IGCSE equivalency",
            source_system: "igcse_a_level",
            visible_to_students_and_parents: true,
          },
          ...INCOMPLETE,
        },
      ],
    },
    "/api/grading/students/{studentId}/multi-year-results": {
      student_id: "stu-1",
      results: [
        {
          config: { id: "cfg-1", name: "Tawjihi two years", visible_to_students_and_parents: true },
          status: "complete",
          overall_percentage: 83.5,
          years: [
            {
              grade_level: { id: "grade-11", name: "Grade 11" },
              weight: 40,
              share: 40,
              status: "finalized",
              academic_year: { id: "y0", name: "2025-2026" },
              overall_percentage: 85,
            },
            {
              grade_level: { id: "grade-12", name: "Grade 12" },
              weight: 60,
              share: 60,
              status: "finalized",
              academic_year: { id: "year-1", name: "2026-2027" },
              overall_percentage: 82.5,
            },
          ],
          subjects: [
            {
              subject_id: "math",
              code: "MATH",
              name: "Mathematics",
              percentage: 78,
              years_counted: 2,
              by_year: [
                { grade_level_id: "grade-11", percentage: 90 },
                { grade_level_id: "grade-12", percentage: 70 },
              ],
            },
          ],
        },
      ],
    },
    "/api/academics/years": { academic_years: [YEAR], total: 1 },
    "/api/academics/grade-levels": { grade_levels: [GRADE_11, GRADE_12], total: 2 },
    "/api/academics/subjects": { subjects: [], total: 0 },
    "/api/grading/years/{yearId}/overview": OVERVIEW,
  }),
);
const getMock = mock((path: string, _init?: unknown) =>
  Promise.resolve<unknown>({ data: GET_RESPONSES.get(path) }),
);
const postMock = mock((path: string, _init?: unknown) =>
  Promise.resolve<unknown>({
    data: path.includes("multi-year") ? CONFIG : IGCSE_SET,
  }),
);
const putMock = mock((_path: string, _init?: unknown) =>
  Promise.resolve<unknown>({ data: CONFIG }),
);
const deleteMock = mock((_path: string, _init?: unknown) =>
  Promise.resolve<unknown>({ data: undefined }),
);
// downloadCsv is replaced (as SchoolMembersPage.test.tsx does): Bun keeps module mocks for the
// whole run, so stubbing the DOM download behind it is unreliable when another file mocks it first.
const downloadMock = mock((_filename: string, _csv: string) => undefined);
mock.module("../../../lib/csv", () => ({ ...realCsv, downloadCsv: downloadMock }));

mock.module("../../../lib/api", () => ({
  api: { GET: getMock, POST: postMock, PUT: putMock, DELETE: deleteMock },
}));

async function wrap(children: ReactNode, path: string) {
  const store = await createTestSessionStore(["PRINCIPAL"]);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <AuthProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <MemoryRouter initialEntries={[path]}>
            <main>{children}</main>
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>
    </AuthProvider>,
  );
}

async function renderTab(tab: string) {
  const Page: ComponentType = (await import("./AcademicSetupPage")).default;
  return wrap(
    <Routes>
      <Route path="/portal/principal/academic-setup/*" element={<Page />} />
    </Routes>,
    `/portal/principal/academic-setup/${tab}?year=year-1`,
  );
}

async function choose(label: string, option: string) {
  const select = screen.getByRole("combobox", { name: label });
  await waitFor(() =>
    expect(select.hasAttribute("disabled") || select.getAttribute("aria-disabled") === "true").toBe(
      false,
    ),
  );
  fireEvent.click(select);
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
  postMock.mockClear();
  putMock.mockClear();
  deleteMock.mockClear();
});

describe("EquivalencyTab", () => {
  test("lists the rule sets as estimates and starts one from an example", async () => {
    const { container } = await renderTab("tawjihi-equivalency");
    const edit = await screen.findByRole("button", { name: "Edit IGCSE equivalency" });
    expect(within(edit.closest("tr")!).getByText("IGCSE subjects (100)")).toBeTruthy();
    expect(screen.getByText(/not an official Ministry of Education conversion/)).toBeTruthy();
    await screen.findByRole("combobox", { name: "Grade" });
    await expectNoA11yViolations(container);

    fireEvent.click(screen.getByRole("button", { name: "Add rule set" }));
    await choose("Start from an example", "American (example)");
    expect(await screen.findByText(/Example values only — not the Ministry's rules/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "American" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Grade 12" }));
    const save = screen.getByRole("button", { name: "Save rule set" });
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    const [path, init] = postMock.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(path).toBe("/api/grading/equivalency-rule-sets");
    const body = init.body as {
      source_system: string;
      grade_level_ids: string[];
      parts: { type: string; exam_ids: string[]; gpa_basis: string | null; required: boolean }[];
    };
    expect(body.source_system).toBe("american");
    expect(body.grade_level_ids).toEqual(["grade-12"]);
    expect(
      body.parts.map((part) => [part.type, part.exam_ids, part.gpa_basis, part.required]),
    ).toEqual([
      ["gpa", [], "gpa", true],
      // The SAT in the catalogue is picked from the example's preset.
      ["exam_total", ["exam-sat"], null, false],
    ]);
  });

  test("the editor checks the parts as the API will", async () => {
    await renderTab("tawjihi-equivalency");
    fireEvent.click(await screen.findByRole("button", { name: "Edit IGCSE equivalency" }));
    const save = await screen.findByRole("button", { name: "Save rule set" });
    expect((save as HTMLButtonElement).disabled).toBe(false);
    const part = screen.getByRole("group", { name: "Part 1" });
    fireEvent.change(within(part).getByLabelText(/^Weight/), { target: { value: "0" } });
    expect(await screen.findByText(/Part 1: The weight is above 0/)).toBeTruthy();
    expect((save as HTMLButtonElement).disabled).toBe(true);
  });

  test("lists a grade's estimates with what is missing, and downloads them as CSV", async () => {
    await renderTab("tawjihi-equivalency");
    await screen.findByRole("button", { name: "Edit IGCSE equivalency" });
    await choose("Grade", "Grade 12");
    expect(await screen.findByText("Amal Haddad")).toBeTruthy();
    expect(screen.getByText("95.5%")).toBeTruthy();
    expect(
      screen.getByText("IGCSE subjects: No results recorded for this part's exams."),
    ).toBeTruthy();
    downloadMock.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    await waitFor(() => expect(downloadMock).toHaveBeenCalledTimes(1));
    const [filename, csv] = downloadMock.mock.calls[0]!;
    expect(filename).toBe("igcse-equivalency-grade-12-2026-2027-estimates.csv");
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(
      "Admission number,First name,Last name,Section,Status,Estimate,IGCSE subjects,Missing data",
    );
    expect(lines[1]).toBe("A-1,Amal,Haddad,12A,Estimated,95.5,95.5,");
    expect(lines[2]).toBe(
      "A-2,Badr,Nasser,12A,Missing data,,,IGCSE subjects: No results recorded for this part's exams.",
    );
  });
});

describe("MultiYearTab", () => {
  test("lists the configurations and checks the weights", async () => {
    const { container } = await renderTab("multi-year-results");
    const edit = await screen.findByRole("button", { name: "Edit Tawjihi two years" });
    expect(within(edit.closest("tr")!).getByText("Grade 11 × 40 + Grade 12 × 60")).toBeTruthy();
    await expectNoA11yViolations(container);

    fireEvent.click(edit);
    const save = await screen.findByRole("button", { name: "Save multi-year result" });
    fireEvent.change(screen.getByLabelText(/^Weight 2/), { target: { value: "120" } });
    expect(await screen.findByText(/Each weight is above 0 and at most 100/)).toBeTruthy();
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/^Weight 2/), { target: { value: "60" } });
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
    const [path, init] = putMock.mock.calls[0] as [string, { body: unknown }];
    expect(path).toBe("/api/grading/multi-year-result-configs/{configId}");
    expect(init.body).toEqual({
      name: "Tawjihi two years",
      is_active: true,
      visible_to_students_and_parents: false,
      years: [
        { grade_level_id: "grade-11", weight: 40 },
        { grade_level_id: "grade-12", weight: 60 },
      ],
    });
  });
});

describe("student page panels", () => {
  test("show the estimate step by step and the multi-year result", async () => {
    const { EquivalencyPanel, MultiYearPanel } = await import("../students/EquivalencyPanels");
    const { container } = await wrap(
      <>
        <EquivalencyPanel studentId="stu-1" />
        <MultiYearPanel studentId="stu-1" />
      </>,
      "/",
    );
    expect(await screen.findByText("Tawjihi equivalency (estimate)")).toBeTruthy();
    expect(screen.getByText(/not an official Ministry of Education conversion/)).toBeTruthy();
    expect(screen.getByText("Missing data")).toBeTruthy();
    expect(
      screen.getByText("IGCSE subjects: No results recorded for this part's exams."),
    ).toBeTruthy();
    expect(await screen.findByText("Weighted result: 83.5%")).toBeTruthy();
    const math = screen.getByText("Mathematics").closest("tr")!;
    expect(
      within(math)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    ).toEqual(["Mathematics", "90%", "70%", "78%"]);
    await expectNoA11yViolations(container);
  });
});
