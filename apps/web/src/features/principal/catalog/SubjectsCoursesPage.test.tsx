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
 * Subjects & courses: lists each subject with its courses, renames a course without resending its
 * unchanged credit hours (fixed once grades are published), and removes a subject. Plus an
 * accessibility pass.
 */

const STAMP = { created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z" };
const MATHS = {
  id: "subject-1",
  school_id: "school-1",
  code: "MATH",
  name: "Mathematics",
  description: null,
  status: "active",
  ...STAMP,
};
const ALGEBRA = {
  id: "course-1",
  school_id: "school-1",
  subject_id: "subject-1",
  code: "ALG1",
  name: "Algebra I",
  description: null,
  credit_hours: 3,
  status: "active",
  ...STAMP,
};

const getMock = mock((path: string, _init?: unknown) => {
  switch (path) {
    case "/api/academics/subjects":
      return Promise.resolve<unknown>({ data: { subjects: [MATHS], total: 1 } });
    case "/api/academics/subjects/{subjectId}/courses":
      return Promise.resolve<unknown>({ data: { courses: [ALGEBRA], total: 1 } });
    default:
      return Promise.resolve<unknown>({ data: undefined });
  }
});
const patchMock = mock((_path: string, _init?: unknown) =>
  Promise.resolve<unknown>({ data: { ...ALGEBRA, name: "Algebra 1" } }),
);
const deleteMock = mock((_path: string, _init?: unknown) =>
  Promise.resolve<unknown>({ data: undefined }),
);
mock.module("../../../lib/api", () => ({
  api: { GET: getMock, PATCH: patchMock, DELETE: deleteMock, POST: mock() },
}));

async function renderPage() {
  const Page: ComponentType = (await import("./SubjectsCoursesPage")).default;
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
  patchMock.mockClear();
  deleteMock.mockClear();
});

describe("SubjectsCoursesPage", () => {
  test("renames a course without resending its unchanged credit hours", async () => {
    await renderPage();

    expect(await screen.findByText("1 course")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Edit Algebra I" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit course" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: /^Name/ }), {
      target: { value: "Algebra 1" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith("/api/academics/courses/{courseId}", {
        params: { path: { courseId: "course-1" } },
        body: { code: "ALG1", name: "Algebra 1", status: "active" },
      }),
    );
    expect(await screen.findByText("Course saved")).toBeTruthy();
  });

  test("removes a subject after explaining it is archived while still used", async () => {
    await renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Remove Mathematics" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove Mathematics?" });
    expect(within(dialog).getByText(/archived instead of deleted/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));

    await waitFor(() =>
      expect(deleteMock).toHaveBeenCalledWith("/api/academics/subjects/{subjectId}", {
        params: { path: { subjectId: "subject-1" } },
      }),
    );
  });

  test("has no accessibility violations", async () => {
    const { container } = await renderPage();
    await screen.findByRole("button", { name: "Edit Algebra I" });
    await expectNoA11yViolations(container);
  });
});
