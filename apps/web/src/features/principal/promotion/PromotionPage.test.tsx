import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import { AuthProvider } from "../../../lib/auth";
import { expectNoA11yViolations } from "../../../lib/test/axe";
import { createTestSessionStore } from "../../../lib/test/session";

import type { ComponentType } from "react";

/**
 * Move students to next year: the preview proposes each student's destination, a student without a
 * result blocks confirming until the principal chooses, students already moved are left out, and
 * confirming sends one decision per remaining student and shows what happened.
 */

const SOURCE = {
  id: "year-1",
  name: "2025-2026",
  status: "active",
  starts_on: "2025-09-01",
  ends_on: "2026-06-30",
};
const TARGET = {
  id: "year-2",
  name: "2026-2027",
  status: "planned",
  starts_on: "2026-09-01",
  ends_on: "2027-06-30",
};

function student(overrides: Record<string, unknown>) {
  return {
    admission_number: null,
    student_status: "enrolled",
    source_section_id: "sec-8a",
    source_section_name: "A",
    source_grade_level_id: "g8",
    source_grade_level_name: "Grade 8",
    average_percentage: 80,
    proposed_section_id: null,
    needs_decision: false,
    done: null,
    placed_section_id: null,
    ...overrides,
  };
}

const PREVIEW = {
  source_year: { id: "year-1", name: "2025-2026", status: "active" },
  target_year: { id: "year-2", name: "2026-2027", status: "planned" },
  target_sections: [
    {
      id: "new-9a",
      name: "A",
      grade_level_id: "g9",
      grade_level_name: "Grade 9",
      grade_sort_order: 9,
      student_count: 1,
    },
  ],
  students: [
    student({
      student_id: "ali",
      first_name: "Ali",
      last_name: "Hassan",
      academic_status: "promoted",
      proposed_action: "place",
      proposed_section_id: "new-9a",
      reason: "promoted",
    }),
    student({
      student_id: "badr",
      first_name: "Badr",
      last_name: "Saleh",
      academic_status: null,
      proposed_action: "skip",
      reason: "no_result",
      needs_decision: true,
    }),
    student({
      student_id: "carl",
      first_name: "Carl",
      last_name: "Nour",
      academic_status: "promoted",
      proposed_action: "place",
      proposed_section_id: "new-9a",
      reason: "already_placed",
      done: "placed",
      placed_section_id: "new-9a",
    }),
  ],
};

const getMock = mock((path: string) => {
  switch (path) {
    case "/api/academics/years":
      return Promise.resolve<unknown>({ data: { academic_years: [SOURCE, TARGET], total: 2 } });
    case "/api/academics/promotions/preview":
      return Promise.resolve<unknown>({ data: PREVIEW });
    default:
      return Promise.resolve<unknown>({ data: undefined });
  }
});
const postMock = mock((_path: string, _init?: unknown) =>
  Promise.resolve<unknown>({
    data: {
      outcomes: [
        { student_id: "ali", outcome: "moved_up", section_id: "new-9a", error: null },
        { student_id: "badr", outcome: "graduated", section_id: null, error: null },
      ],
    },
  }),
);
mock.module("../../../lib/api", () => ({
  api: { GET: getMock, POST: postMock },
}));

async function renderPage() {
  const Page: ComponentType = (await import("./PromotionPage")).default;
  const store = await createTestSessionStore(["PRINCIPAL"]);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <AuthProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <MemoryRouter>
            <main>
              <Page />
            </main>
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>
    </AuthProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
  postMock.mockClear();
});

describe("PromotionPage", () => {
  test("proposes destinations, blocks confirming until every student has one, then moves them", async () => {
    await renderPage();

    // Ali's proposal comes from his result; Carl was already moved, so he has no picker.
    const ali = await screen.findByRole("combobox", { name: /Destination for Ali Hassan/ });
    expect(ali.textContent).toContain("Grade 9 – A");
    expect(screen.queryByRole("combobox", { name: /Destination for Carl Nour/ })).toBeNull();
    expect(screen.getByText("Moved to Grade 9 – A")).toBeTruthy();
    expect(getMock).toHaveBeenCalledWith("/api/academics/promotions/preview", {
      params: { query: { source_year_id: "year-1", target_year_id: "year-2" } },
    });

    // Badr has no result, so nothing is guessed and confirming waits for a choice.
    expect(screen.getByText("1 student still needs a destination.")).toBeTruthy();
    const move = screen.getByRole("button", { name: "Move students" });
    expect(move.hasAttribute("disabled") || move.getAttribute("aria-disabled") === "true").toBe(
      true,
    );

    fireEvent.click(screen.getByRole("combobox", { name: /Destination for Badr Saleh/ }));
    fireEvent.click(await screen.findByRole("option", { name: "Graduate" }));
    await waitFor(() =>
      expect(screen.queryByText("1 student still needs a destination.")).toBeNull(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Move students" }));
    const dialog = await screen.findByRole("dialog", { name: "Move students to 2026-2027?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Move students" }));

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith("/api/academics/promotions/apply", {
        body: {
          source_year_id: "year-1",
          target_year_id: "year-2",
          decisions: [
            { student_id: "ali", action: "place", target_section_id: "new-9a" },
            { student_id: "badr", action: "graduate" },
          ],
        },
      }),
    );
    expect(await screen.findByText("1 moved up a grade")).toBeTruthy();
    expect(screen.getByText("1 graduated")).toBeTruthy();
  });

  test("has no accessibility violations", async () => {
    const { container } = await renderPage();
    await screen.findByRole("combobox", { name: /Destination for Ali Hassan/ });
    await expectNoA11yViolations(container);
  });
});
