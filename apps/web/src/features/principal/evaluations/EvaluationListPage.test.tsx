import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import type { ComponentType } from "react";

function evaluation(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "evaluation-1",
    school_id: "school-1",
    teacher_id: "teacher-1",
    evaluator_user_id: "principal-1",
    class_id: null,
    evaluation_type: "formal_observation",
    rating: null,
    strengths: null,
    areas_for_improvement: null,
    comments: null,
    narrative: null,
    status: "draft",
    shared_with_teacher: false,
    shared_at: null,
    evaluated_at: "2026-08-16T10:00:00.000Z",
    created_at: "2026-08-16T10:00:00.000Z",
    updated_at: "2026-08-16T10:00:00.000Z",
    scores: [],
    ...overrides,
  };
}

const TEACHER_USER = { id: "user-1", display_name: "Jordan Lee", email: "jordan@example.com" };
const TEACHER = { id: "teacher-1", user_id: "user-1", employee_number: "T-001" };

const getMock = mock((path: string, init?: { params?: { query?: Record<string, unknown> } }) => {
  const query = init?.params?.query ?? {};
  if (path === "/api/teachers") {
    return Promise.resolve<unknown>({ data: { teachers: [TEACHER], next_cursor: null } });
  }
  if (path === "/api/users") {
    return Promise.resolve<unknown>({ data: { users: [TEACHER_USER], next_cursor: null } });
  }
  if (path === "/api/evaluations") {
    if (query.status === "submitted") {
      return Promise.resolve<unknown>({ data: { evaluations: [], total: 0 } });
    }
    return Promise.resolve<unknown>({ data: { evaluations: [evaluation()], total: 1 } });
  }
  return Promise.resolve<unknown>({ data: {} });
});

mock.module("../../../lib/api", () => ({ api: { GET: getMock } }));

const loadEvaluationListPage = async (): Promise<ComponentType> =>
  (await import("./EvaluationListPage")).default;

function renderPage(Page: ComponentType) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter>
          <Page />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
});

describe("EvaluationListPage", () => {
  test("lists evaluations with the teacher's resolved name", async () => {
    renderPage(await loadEvaluationListPage());

    const link = await screen.findByRole("link", { name: "Jordan Lee" });
    expect(link.getAttribute("href")).toBe("/portal/principal/evaluations/evaluation-1");
  });

  test("filtering by status re-queries and can produce an empty result", async () => {
    renderPage(await loadEvaluationListPage());

    await screen.findByRole("link", { name: "Jordan Lee" });

    fireEvent.click(screen.getByRole("combobox", { name: "Status" }));
    fireEvent.click(await screen.findByRole("option", { name: "Submitted" }));

    expect(await screen.findByText("No evaluations match this filter.")).toBeTruthy();
  });

  test("New evaluation opens the create-evaluation dialog", async () => {
    renderPage(await loadEvaluationListPage());

    fireEvent.click(screen.getByRole("button", { name: "New evaluation" }));

    expect(await screen.findByRole("dialog", { name: "Start a teacher evaluation" })).toBeTruthy();
  });
});
