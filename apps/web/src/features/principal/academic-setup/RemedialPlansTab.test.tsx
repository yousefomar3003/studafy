import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";

import { expectNoA11yViolations } from "../../../lib/test/axe";

import type { SetupContext } from "./context";
import type { RemedialPlan, RemedialPlanList, RemedialPlanSummary } from "./remedial-plans";

/**
 * Remedial plans in academic setup: leadership sees the year's counts and plans (overdue first),
 * filters them, opens a plan's targets, reviews and timeline, adds a follow-up note, and turns
 * sharing with students and parents on or off.
 */

const STAMP = { created_at: "2026-10-01T08:00:00.000Z", updated_at: "2026-10-02T08:00:00.000Z" };

const SUMMARY: RemedialPlanSummary = {
  id: "plan-1",
  academic_year_id: "year-1",
  term_id: null,
  term_name: null,
  section_id: "sec-10a",
  section_name: "A",
  grade_level_id: "grade-10",
  grade_level_name: "Grade 10",
  student_id: "stu-1",
  student_first_name: "Lina",
  student_last_name: "Haddad",
  admission_number: "ADM-1",
  subject_id: "sub-math",
  subject_name: "Mathematics",
  reason: "below_pass",
  status: "in_progress",
  shared_with_family: false,
  next_review_on: "2026-10-20",
  overdue: true,
  last_note_at: "2026-10-05T09:00:00.000Z",
  created_by_name: "Omar Aziz",
  ...STAMP,
};

const LIST: RemedialPlanList = {
  academic_year_id: "year-1",
  counts: { open: 2, in_progress: 1, achieved: 3, closed: 0, overdue: 1 },
  plans: [SUMMARY],
  truncated: false,
};

const PLAN: RemedialPlan = {
  ...SUMMARY,
  reason_note: null,
  targets: "Solve linear equations",
  actions: "Weekly practice sheet",
  start_percentage: 38,
  pass_percentage: 50,
  reviews: [
    { review_on: "2026-10-20", completed_at: null, overdue: true },
    { review_on: "2026-11-20", completed_at: null, overdue: false },
  ],
  notes: [
    {
      id: "note-1",
      kind: "status_change",
      body: "Sessions started",
      new_status: "in_progress",
      internal: false,
      author_name: "Omar Aziz",
      author_access: "teacher",
      created_at: "2026-10-05T09:00:00.000Z",
    },
  ],
  access: "leadership",
  can_edit: true,
  can_add_note: true,
  family_sharing_enabled: false,
};

const getMock = mock((path: string, _init?: unknown) => {
  const data: Record<string, unknown> = {
    "/api/grading/remedial-plans": LIST,
    "/api/grading/remedial-plans/{planId}": PLAN,
    "/api/grading/remedial-plan-settings": { family_visible: false },
    "/api/academics/grade-levels": {
      grade_levels: [{ id: "grade-10", school_id: "school-1", name: "Grade 10", sort_order: 10 }],
      total: 1,
    },
    "/api/academics/subjects": {
      subjects: [{ id: "sub-math", code: "MTH", name: "Mathematics", ...STAMP }],
      total: 1,
    },
  };
  // eslint-disable-next-line security/detect-object-injection -- a test fixture keyed by route
  return Promise.resolve<unknown>({ data: data[path] });
});
const postMock = mock((_path: string, _init?: unknown) => Promise.resolve<unknown>({ data: PLAN }));
const putMock = mock((_path: string, init?: unknown) =>
  Promise.resolve<unknown>({ data: (init as { body: unknown }).body }),
);
mock.module("../../../lib/api", () => ({
  api: { GET: getMock, POST: postMock, PUT: putMock, PATCH: mock(), DELETE: mock() },
}));

const ctxWith = (manage: boolean) =>
  ({
    year: { id: "year-1", name: "2026-2027" },
    years: [],
    overview: undefined,
    status: "active",
    configEditable: true,
    can: { manage, finalize: true, certify: true, review: true, reportNotes: true },
    search: "?year=year-1",
  }) as unknown as SetupContext;

async function renderTab(manage = true) {
  const { RemedialPlansTab } = await import("./RemedialPlansTab");
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <main>
          <RemedialPlansTab ctx={ctxWith(manage)} />
        </main>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
  postMock.mockClear();
  putMock.mockClear();
});

describe("RemedialPlansTab", () => {
  test("shows the year's counts and plans, overdue reviews flagged", async () => {
    const { container } = await renderTab();
    const view = await screen.findByRole("button", { name: "View Lina Haddad's Mathematics plan" });
    const row = view.closest("tr")!;
    expect(within(row).getByText("In progress")).toBeTruthy();
    expect(within(row).getByText("Overdue")).toBeTruthy();
    expect(within(row).getByText("Grade 10 – A")).toBeTruthy();
    const counts = screen.getByRole("list", { name: "Plans by status" });
    expect(counts.textContent).toContain("Achieved 3");
    expect(counts.textContent).toContain("Overdue reviews 1");
    expect(getMock.mock.calls.find(([path]) => path === "/api/grading/remedial-plans")).toEqual([
      "/api/grading/remedial-plans",
      {
        params: {
          query: {
            academic_year_id: "year-1",
            grade_level_id: undefined,
            subject_id: undefined,
            status: undefined,
            overdue: undefined,
          },
        },
      },
    ]);
    await expectNoA11yViolations(container);
  });

  test("filters to overdue reviews", async () => {
    await renderTab();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Overdue reviews only" }));
    await waitFor(() =>
      expect(
        getMock.mock.calls.some(
          ([path, init]) =>
            path === "/api/grading/remedial-plans" &&
            (init as { params: { query: { overdue?: string } } }).params.query.overdue === "true",
        ),
      ).toBe(true),
    );
  });

  test("opens a plan's timeline and adds a staff-only follow-up note", async () => {
    await renderTab();
    fireEvent.click(
      await screen.findByRole("button", { name: "View Lina Haddad's Mathematics plan" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Solve linear equations")).toBeTruthy();
    expect(within(dialog).getByText("Sessions started")).toBeTruthy();
    expect(within(dialog).getByText("Below the pass line")).toBeTruthy();

    fireEvent.change(within(dialog).getByRole("textbox", { name: /Follow-up note/ }), {
      target: { value: "Spoke with the coordinator" },
    });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Staff only/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Add note" }));
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postMock.mock.calls[0]).toEqual([
      "/api/grading/remedial-plans/{planId}/notes",
      {
        params: { path: { planId: "plan-1" } },
        body: { body: "Spoke with the coordinator", internal: true },
      },
    ]);
  });

  test("leadership who manage the setup turn sharing with families on", async () => {
    await renderTab();
    const sharing = await screen.findByRole("checkbox", {
      name: "Teachers may share remedial plans with students and parents",
    });
    fireEvent.click(sharing);
    await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
    expect(putMock.mock.calls[0]).toEqual([
      "/api/grading/remedial-plan-settings",
      { body: { family_visible: true } },
    ]);
  });

  test("the sharing setting is read-only without academicConfig:manage", async () => {
    await renderTab(false);
    const sharing = await screen.findByRole("checkbox", {
      name: "Teachers may share remedial plans with students and parents",
    });
    expect((sharing as HTMLInputElement).disabled).toBe(true);
  });
});
