import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";

import { expectNoA11yViolations } from "../../../lib/test/axe";

import type { SetupContext } from "./context";
import type { CurriculumTemplate, CurriculumTemplatePlan } from "./queries";

/**
 * The curriculum template picker: choose a template and grades, preview what would change, and
 * apply — with `confirm` only when the preview said existing configuration changes.
 */

const AMERICAN: CurriculumTemplate = {
  id: "american",
  family: "american",
  name: "American (GPA 4.0)",
  description: "Letter grades A+ to F on a 4.0 GPA.",
  grading_method: "weighted",
  result_format: "gpa",
  result_scale_max: 4,
  max_marks: 100,
  pass_percentage: 65,
  scale: {
    name: "American A+–F",
    bands: [
      { label: "A+", min_percentage: 97, gpa_points: 4 },
      { label: "F", min_percentage: 0, gpa_points: 0 },
    ],
  },
  descriptors: null,
  categories_source: "template",
  categories: [
    { name: "Tests", kind: "exam", weight: 60, aggregation: "weighted_average", max_marks: 60 },
    {
      name: "Homework",
      kind: "homework",
      weight: 40,
      aggregation: "weighted_average",
      max_marks: 40,
    },
  ],
  subject_credits: { credits: 1, average_weight: 1 },
  course_levels: [
    { label: "Standard", gpa_boost: 0 },
    { label: "AP", gpa_boost: 1 },
  ],
};

const PLAN: CurriculumTemplatePlan = {
  template_id: "american",
  template_name: "American (GPA 4.0)",
  academic_year_id: "year-1",
  academic_year_name: "2026-2027",
  locale: "en",
  applied: false,
  requires_confirmation: true,
  scale: { action: "create", scale_id: null, name: "American A+–F" },
  grades: [
    {
      grade_level_id: "grade-10",
      grade_level_name: "Grade 10",
      program: { action: "update", changes: ["grade_scale", "result_format"] },
      descriptors: null,
      error: null,
      subjects: [
        {
          config_id: "cfg-math",
          subject_id: "sub-math",
          subject_name: "Mathematics",
          action: "update",
          reason: null,
          detail: null,
        },
        {
          config_id: "cfg-sci",
          subject_id: "sub-sci",
          subject_name: "Science",
          action: "skip",
          reason: "has_marks",
          detail: null,
        },
      ],
    },
  ],
};

const getMock = mock((path: string, _init?: unknown) => {
  if (path === "/api/grading/curriculum-templates") {
    return Promise.resolve<unknown>({ data: { templates: [AMERICAN] } });
  }
  if (path === "/api/academics/grade-levels") {
    return Promise.resolve<unknown>({
      data: {
        grade_levels: [
          { id: "grade-10", school_id: "school-1", name: "Grade 10", sort_order: 10 },
          { id: "grade-11", school_id: "school-1", name: "Grade 11", sort_order: 11 },
        ],
        total: 2,
      },
    });
  }
  return Promise.resolve<unknown>({ data: undefined });
});
const postMock = mock((path: string, _init?: unknown) =>
  Promise.resolve<unknown>({
    data: path.endsWith("/apply") ? { ...PLAN, applied: true } : PLAN,
  }),
);
mock.module("../../../lib/api", () => ({
  api: { GET: getMock, POST: postMock, PUT: mock(), DELETE: mock() },
}));

const CTX = {
  year: { id: "year-1", name: "2026-2027" },
  years: [],
  overview: undefined,
  status: "draft",
  configEditable: true,
  can: { manage: true, finalize: true, certify: true, review: true, reportNotes: true },
  search: "?year=year-1",
} as unknown as SetupContext;

async function renderDialog(onClose: () => void = mock()) {
  const { CurriculumTemplateDialog } = await import("./CurriculumTemplateDialog");
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <CurriculumTemplateDialog ctx={CTX} onClose={onClose} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
  postMock.mockClear();
});

describe("CurriculumTemplateDialog", () => {
  test("shows what a template sets and that its boundaries are editable defaults", async () => {
    await renderDialog();

    expect(await screen.findByText("Letter grades A+ to F on a 4.0 GPA.")).toBeTruthy();
    expect(screen.getByText("GPA out of 4")).toBeTruthy();
    expect(screen.getByText(/A\+ ≥ 97% \(4\)/)).toBeTruthy();
    expect(screen.getByText(/Tests 60% · Homework 40%/)).toBeTruthy();
    expect(screen.getByText(/AP \(\+1\)/)).toBeTruthy();
    expect(screen.getByText(/editable defaults/)).toBeTruthy();
    // Nothing to preview until a grade is chosen.
    expect(screen.getByRole("button", { name: "Preview" }).hasAttribute("disabled")).toBe(true);
  });

  test("previews the chosen grades, then applies with confirm when existing set-up changes", async () => {
    await renderDialog();

    fireEvent.click(await screen.findByRole("checkbox", { name: "Grade 10" }));
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postMock.mock.calls[0]).toEqual([
      "/api/grading/years/{yearId}/curriculum-template/preview",
      {
        params: { path: { yearId: "year-1" } },
        body: { template_id: "american", grade_level_ids: ["grade-10"] },
      },
    ]);
    expect(await screen.findByText("Create the scale “American A+–F”.")).toBeTruthy();
    expect(screen.getByText("Change the grade's grading scale, result format.")).toBeTruthy();
    expect(screen.getByText("Rebuilt on the template")).toBeTruthy();
    expect(screen.getByText(/it already has marks/)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "Subjects with marks are never changed",
    );

    fireEvent.click(screen.getByRole("button", { name: "Apply and change existing set-up" }));
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(2));
    expect(postMock.mock.calls[1]).toEqual([
      "/api/grading/years/{yearId}/curriculum-template/apply",
      {
        params: { path: { yearId: "year-1" } },
        body: { template_id: "american", grade_level_ids: ["grade-10"], confirm: true },
      },
    ]);
    expect(await screen.findByText(/American \(GPA 4.0\) was applied/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
  });

  test("has no accessibility violations", async () => {
    const { baseElement } = await renderDialog();
    await screen.findByText("Letter grades A+ to F on a 4.0 GPA.");
    await expectNoA11yViolations(baseElement);
  });
});
