import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, mock, test } from "bun:test";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { expectNoA11yViolations } from "../../../lib/test/axe";

import type { ComponentType } from "react";

/**
 * Automated accessibility audit for the teacher evaluation screens (ST-199), mirroring
 * `discipline/a11y.test.tsx` — one render per representative state inside a `<main>`, matching how
 * `RootLayout` wraps every route.
 */

const TEACHER_USER = { id: "user-1", display_name: "Jordan Lee", email: "jordan@example.com" };
const TEACHER = { id: "teacher-1", user_id: "user-1", employee_number: "T-001" };

const TEMPLATE = {
  id: "template-1",
  school_id: "school-1",
  title: "Classroom management",
  description: "Manages classroom behavior and time effectively.",
  max_score: 10,
  sort_order: 0,
  is_active: true,
  created_at: "2026-08-16T10:00:00.000Z",
  updated_at: "2026-08-16T10:00:00.000Z",
};

const EVALUATION = {
  id: "evaluation-1",
  school_id: "school-1",
  teacher_id: "teacher-1",
  evaluator_user_id: "principal-1",
  class_id: null,
  evaluation_type: "formal_observation",
  rating: "proficient",
  strengths: "Clear instructions.",
  areas_for_improvement: "Pacing.",
  comments: null,
  narrative: null,
  status: "draft",
  shared_with_teacher: false,
  shared_at: null,
  evaluated_at: "2026-08-16T10:00:00.000Z",
  created_at: "2026-08-16T10:00:00.000Z",
  updated_at: "2026-08-16T10:00:00.000Z",
  scores: [],
};

const getMock = mock((path: string) => {
  if (path === "/api/evaluations/{evaluationId}") {
    return Promise.resolve<unknown>({ data: EVALUATION });
  }
  if (path === "/api/evaluations") {
    return Promise.resolve<unknown>({ data: { evaluations: [EVALUATION], total: 1 } });
  }
  if (path === "/api/evaluations/templates") {
    return Promise.resolve<unknown>({ data: { templates: [TEMPLATE], total: 1 } });
  }
  if (path === "/api/teachers") {
    return Promise.resolve<unknown>({ data: { teachers: [TEACHER], next_cursor: null } });
  }
  if (path === "/api/users") {
    return Promise.resolve<unknown>({ data: { users: [TEACHER_USER], next_cursor: null } });
  }
  return Promise.resolve<unknown>({ data: {} });
});

mock.module("../../../lib/api", () => ({ api: { GET: getMock } }));

const loadEvaluationListPage = async (): Promise<ComponentType> =>
  (await import("./EvaluationListPage")).default;
const loadEvaluationDetailPage = async (): Promise<ComponentType> =>
  (await import("./EvaluationDetailPage")).default;
const loadCriteriaTemplatesPage = async (): Promise<ComponentType> =>
  (await import("./CriteriaTemplatesPage")).default;

function renderListInMain(Page: ComponentType) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter>
          <main>
            <Page />
          </main>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function renderDetailInMain(Page: ComponentType) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/portal/principal/evaluations/evaluation-1"]}>
          <main>
            <Routes>
              <Route path="/portal/principal/evaluations/:evaluationId" element={<Page />} />
            </Routes>
          </main>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
});

describe("teacher evaluation accessibility", () => {
  test("evaluation list", async () => {
    const { container } = renderListInMain(await loadEvaluationListPage());
    await screen.findByRole("heading", { name: "Teacher evaluations" });

    await expectNoA11yViolations(container);
  });

  test("new-evaluation modal open", async () => {
    const { container } = renderListInMain(await loadEvaluationListPage());
    await screen.findByRole("heading", { name: "Teacher evaluations" });

    fireEvent.click(screen.getByRole("button", { name: "New evaluation" }));
    await screen.findByRole("dialog", { name: "Start a teacher evaluation" });

    await expectNoA11yViolations(container);
  });

  test("evaluation detail with scoring and narrative", async () => {
    const { container } = renderDetailInMain(await loadEvaluationDetailPage());
    await screen.findByRole("heading", { name: "Jordan Lee" });
    await screen.findByText("Classroom management");

    await expectNoA11yViolations(container);
  });

  test("criteria templates list", async () => {
    const { container } = renderListInMain(await loadCriteriaTemplatesPage());
    await screen.findByRole("heading", { name: "Criteria templates" });

    await expectNoA11yViolations(container);
  });

  test("new-template modal open", async () => {
    const { container } = renderListInMain(await loadCriteriaTemplatesPage());
    await screen.findByRole("heading", { name: "Criteria templates" });

    fireEvent.click(screen.getByRole("button", { name: "New template" }));
    await screen.findByRole("dialog", { name: "New criteria template" });

    await expectNoA11yViolations(container);
  });
});
