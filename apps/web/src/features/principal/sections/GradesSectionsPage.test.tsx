import { ApiError } from "@studafy/api-client";
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
 * Grades & sections page: lists the school's grades and the selected year's sections, adds a grade,
 * explains a refused grade delete, and manages a section's students — adding one whose placement
 * skipped a full class, and removing one. Plus an accessibility pass over the page and the roster.
 */

const STAMP = { created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z" };
const YEAR = {
  id: "year-1",
  name: "2026-2027",
  status: "active",
  starts_on: "2026-09-01",
  ends_on: "2027-06-30",
};
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
const PLACED = {
  student_id: "student-1",
  section_id: "sec-10c",
  academic_year_id: "year-1",
  first_name: "Lina",
  last_name: "Haddad",
  admission_number: "ADM-001",
};
const SEARCHED = {
  id: "student-2",
  first_name: "Sam",
  last_name: "Lee",
  preferred_name: null,
  admission_number: "ADM-002",
};

function getImplementation(path: string) {
  switch (path) {
    case "/api/academics/years":
      return Promise.resolve<unknown>({ data: { academic_years: [YEAR], total: 1 } });
    case "/api/academics/grade-levels":
      return Promise.resolve<unknown>({ data: { grade_levels: [GRADE_10], total: 1 } });
    case "/api/academics/sections":
      return Promise.resolve<unknown>({ data: { sections: [SECTION_10C], total: 1 } });
    case "/api/academics/sections/{sectionId}/students":
      return Promise.resolve<unknown>({ data: { students: [PLACED], total: 1 } });
    case "/api/academics/classes":
      return Promise.resolve<unknown>({
        data: { classes: [{ id: "class-full", code: "MATH-101" }], total: 1 },
      });
    case "/api/students":
      return Promise.resolve<unknown>({ data: { students: [SEARCHED], next_cursor: null } });
    default:
      return Promise.resolve<unknown>({ data: undefined });
  }
}

const getMock = mock(getImplementation);
const postMock = mock((path: string, _init?: unknown) => {
  if (path === "/api/academics/sections/{sectionId}/students") {
    return Promise.resolve<unknown>({
      data: {
        student: { ...PLACED, student_id: "student-2", first_name: "Sam", last_name: "Lee" },
        enrolled_class_ids: [],
        skipped_class_ids: ["class-full"],
      },
    });
  }
  return Promise.resolve<unknown>({ data: { ...GRADE_10, id: "grade-12", name: "Grade 12" } });
});
const patchMock = mock((_path: string, _init?: unknown) => Promise.resolve<unknown>({ data: {} }));
const deleteMock = mock((_path: string, _init?: unknown) =>
  Promise.resolve<unknown>({ data: undefined }),
);
mock.module("../../../lib/api", () => ({
  api: { GET: getMock, POST: postMock, PATCH: patchMock, DELETE: deleteMock },
}));

async function renderPage() {
  const Page: ComponentType = (await import("./GradesSectionsPage")).default;
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
  patchMock.mockClear();
  deleteMock.mockReset();
  deleteMock.mockImplementation(() => Promise.resolve<unknown>({ data: undefined }));
});

describe("GradesSectionsPage", () => {
  test("lists grades and the year's sections, and adds a grade after the existing ones", async () => {
    await renderPage();

    expect(await screen.findByRole("button", { name: "Edit Grade 10" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Students of Grade 10 – C" })).toBeTruthy();
    // Classes are attached to these sections on the Classes page, linked from the header.
    expect(screen.getByRole("link", { name: "Classes" }).getAttribute("href")).toBe(
      "/portal/principal/classes",
    );
    expect(getMock).toHaveBeenCalledWith("/api/academics/sections", {
      params: { query: { academic_year_id: "year-1", limit: 100, offset: 0 } },
    });

    fireEvent.click(screen.getByRole("button", { name: "Add grade" }));
    const dialog = await screen.findByRole("dialog", { name: "Add grade" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: /^Name/ }), {
      target: { value: "Grade 12" },
    });
    // The order defaults to just after the highest existing one.
    expect(
      (within(dialog).getByRole("spinbutton", { name: /^Order/ }) as HTMLInputElement).value,
    ).toBe("11");
    fireEvent.click(within(dialog).getByRole("button", { name: "Add grade" }));

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith("/api/academics/grade-levels", {
        body: { name: "Grade 12", sort_order: 11 },
      }),
    );
    await screen.findByText("Grade added");
  });

  test("explains why a grade with sections can't be deleted", async () => {
    deleteMock.mockImplementation(() =>
      Promise.reject(
        new ApiError({
          status: 409,
          title: "Conflict",
          code: "GRADE_LEVEL_HAS_SECTIONS",
          detail: "Delete this grade's sections first.",
          instance: null,
          type: null,
          request_id: null,
          problem: null,
        }),
      ),
    );
    await renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Delete Grade 10" }));
    const confirm = await screen.findByRole("dialog", { name: "Delete Grade 10?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));

    expect(
      await screen.findByText(
        "This grade still has sections (in this or another year). Delete them first.",
      ),
    ).toBeTruthy();
    expect(deleteMock).toHaveBeenCalledWith("/api/academics/grade-levels/{gradeLevelId}", {
      params: { path: { gradeLevelId: "grade-10" } },
    });
  });

  test("adds a student to a section, naming the full class they weren't enrolled in, and removes one", async () => {
    await renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Students of Grade 10 – C" }));
    const dialog = await screen.findByRole("dialog", { name: "Students of Grade 10 – C" });
    expect(await within(dialog).findByText("Lina Haddad")).toBeTruthy();

    fireEvent.change(within(dialog).getByRole("searchbox", { name: /Find a student/ }), {
      target: { value: "Sam" },
    });
    fireEvent.click(await within(dialog).findByRole("button", { name: "Add Sam Lee" }));

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith("/api/academics/sections/{sectionId}/students", {
        params: { path: { sectionId: "sec-10c" } },
        body: { student_id: "student-2" },
      }),
    );
    expect(
      await within(dialog).findByText("Not enrolled in 1 class because it is full: MATH-101."),
    ).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Remove Lina Haddad" }));
    await waitFor(() =>
      expect(deleteMock).toHaveBeenCalledWith(
        "/api/academics/sections/{sectionId}/students/{studentId}",
        { params: { path: { sectionId: "sec-10c", studentId: "student-1" } } },
      ),
    );
  });

  test("has no accessibility violations on the page or the section roster", async () => {
    const { container } = await renderPage();
    await screen.findByRole("button", { name: "Students of Grade 10 – C" });
    await expectNoA11yViolations(container);

    fireEvent.click(screen.getByRole("button", { name: "Students of Grade 10 – C" }));
    const dialog = await screen.findByRole("dialog", { name: "Students of Grade 10 – C" });
    await within(dialog).findByText("Lina Haddad");
    await expectNoA11yViolations(container);
  });
});
