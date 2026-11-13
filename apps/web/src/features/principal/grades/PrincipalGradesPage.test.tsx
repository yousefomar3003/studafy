import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import type { GradeSubmission } from "../school/queries";
import type { ComponentType } from "react";

const today = new Date();
const iso = (date: Date) => date.toISOString().slice(0, 10);
const TERM = {
  id: "term-1",
  name: "Term 1",
  starts_on: iso(new Date(today.getTime() - 30 * 86_400_000)),
  ends_on: iso(new Date(today.getTime() + 30 * 86_400_000)),
};

function grade(label: string, score: number | null, maxScore: number, weight: number) {
  return { id: `g-${label}`, label, score, max_score: maxScore, weight };
}

function submission(id: string, studentId: string, status: string, grades: unknown[]) {
  return { id, student_id: studentId, status, grades } as unknown as GradeSubmission;
}

const SUBMISSIONS = [
  submission("s1", "st-1", "submitted", [grade("Quiz 1", 8, 10, 1), grade("Final", 45, 50, 3)]),
  submission("s2", "st-2", "draft", [grade("Quiz 1", null, 10, 1), grade("Final", null, 50, 3)]),
];

function responseFor(path: string): Promise<{ data: unknown }> {
  switch (path) {
    case "/api/academics/years":
      return Promise.resolve({
        data: {
          academic_years: [
            { id: "y1", name: "2026–2027", status: "active", starts_on: "2026-01-01" },
          ],
          total: 1,
        },
      });
    case "/api/academics/years/{yearId}/terms":
      return Promise.resolve({ data: { terms: [TERM], total: 1 } });
    case "/api/academics/classes":
      return Promise.resolve({ data: { classes: [{ id: "c1", code: "MATH101-A" }], total: 1 } });
    case "/api/grades/gradebooks":
      return Promise.resolve({ data: { id: "gb-1", class_id: "c1" } });
    case "/api/grades/gradebooks/{gradebookId}/entry":
      return Promise.resolve({ data: { submissions: SUBMISSIONS } });
    case "/api/students":
      return Promise.resolve({
        data: {
          students: [
            { id: "st-1", first_name: "Yara", last_name: "Khalil", preferred_name: null },
            { id: "st-2", first_name: "Adam", last_name: "Fares", preferred_name: null },
          ],
          next_cursor: null,
        },
      });
    default:
      return Promise.resolve({ data: undefined });
  }
}

const getMock = mock((path: string) => responseFor(path));
mock.module("../../../lib/api", () => ({ api: { GET: getMock } }));

async function renderPage() {
  const Page: ComponentType = (await import("./PrincipalGradesPage")).default;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Page />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe("weightedAverage", () => {
  test("weights each graded assessment and skips ungraded ones", async () => {
    const { weightedAverage } = await import("./PrincipalGradesPage");
    // (8/10 × 1 + 45/50 × 3) / 4 = (0.8 + 2.7) / 4 = 87.5%
    expect(weightedAverage(SUBMISSIONS[0]!)).toBeCloseTo(87.5);
    expect(weightedAverage(SUBMISSIONS[1]!)).toBeNull();
  });
});

describe("PrincipalGradesPage", () => {
  test("shows the current term's first class gradebook with averages and statuses", async () => {
    await renderPage();

    expect(await screen.findByText("Yara Khalil")).toBeTruthy();
    expect(screen.getByText("Adam Fares")).toBeTruthy();
    expect(screen.getByText("Quiz 1 (10)")).toBeTruthy();
    expect(screen.getByText("Final (50)")).toBeTruthy();
    expect(screen.getByText("87.5%")).toBeTruthy();
    expect(screen.getByText("Awaiting approval")).toBeTruthy();
    expect(screen.getByText("Draft")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Review 1 pending submission →" }).getAttribute("href"),
    ).toBe("/portal/approvals");
  });
});
