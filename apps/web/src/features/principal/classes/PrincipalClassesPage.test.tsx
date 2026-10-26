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
import { todayIso } from "../school/queries";

import type { ComponentType } from "react";

/**
 * The classes list shows each class's grade section; a `timetable:manage` holder can add a class,
 * edit one (only the changed fields are sent), delete one, and add a course for a new class —
 * creating its subject on the way. A session without the permission sees the list read-only.
 */

const today = todayIso();
const CLASS = {
  id: "class-1",
  course_id: "course-1",
  academic_year_id: "year-1",
  term_id: "term-1",
  lead_teacher_id: "teacher-1",
  room_id: null,
  section_id: null,
  code: "MATH-101",
  capacity: null,
  status: "active",
};
const SECTION = {
  id: "sec-10c",
  academic_year_id: "year-1",
  grade_level_id: "grade-10",
  grade_level_name: "Grade 10",
  name: "C",
  student_count: 0,
};
const SUBJECT = { id: "subject-1", code: "MATH", name: "Mathematics", status: "active" };
const COURSE = {
  id: "course-1",
  subject_id: "subject-1",
  code: "MATH101",
  name: "Algebra I",
  status: "active",
  credit_hours: 1,
};

let classes: Record<string, unknown>[] = [CLASS];
let subjects: Record<string, unknown>[] = [SUBJECT];
let courses: Record<string, unknown>[] = [COURSE];

const getMock = mock((path: string, init?: { params?: { path?: { subjectId?: string } } }) => {
  switch (path) {
    case "/api/academics/years":
      return Promise.resolve<unknown>({
        data: {
          academic_years: [
            { id: "year-1", name: "Year", status: "active", starts_on: today, ends_on: today },
          ],
          total: 1,
        },
      });
    case "/api/academics/years/{yearId}/terms":
      return Promise.resolve<unknown>({
        data: {
          terms: [
            {
              id: "term-1",
              academic_year_id: "year-1",
              name: "Term 1",
              starts_on: today,
              ends_on: today,
            },
          ],
          total: 1,
        },
      });
    case "/api/academics/classes":
      return Promise.resolve<unknown>({ data: { classes, total: classes.length } });
    case "/api/academics/sections":
      return Promise.resolve<unknown>({ data: { sections: [SECTION], total: 1 } });
    case "/api/academics/subjects":
      return Promise.resolve<unknown>({ data: { subjects, total: subjects.length } });
    case "/api/academics/subjects/{subjectId}/courses": {
      const own = courses.filter((course) => course.subject_id === init?.params?.path?.subjectId);
      return Promise.resolve<unknown>({ data: { courses: own, total: own.length } });
    }
    case "/api/teachers":
      return Promise.resolve<unknown>({
        data: {
          teachers: [{ id: "teacher-1", user_id: "user-1", employee_number: "T-001" }],
          next_cursor: null,
        },
      });
    case "/api/users":
      return Promise.resolve<unknown>({
        data: { users: [{ id: "user-1", display_name: "Ada Lovelace" }], next_cursor: null },
      });
    case "/api/academics/classes/{classId}/enrollments":
      return Promise.resolve<unknown>({ data: { enrollments: [], total: 0 } });
    default:
      return Promise.resolve<unknown>({ data: undefined });
  }
});
const postMock = mock((path: string, init: { body: Record<string, unknown> }): Promise<unknown> => {
  if (path === "/api/academics/subjects") {
    const subject = { id: "subject-2", ...init.body };
    subjects = [...subjects, subject];
    return Promise.resolve({ data: subject });
  }
  if (path === "/api/academics/subjects/{subjectId}/courses") {
    const course = { id: "course-2", ...init.body };
    courses = [...courses, course];
    return Promise.resolve({ data: course });
  }
  const created = { id: "class-2", room_id: null, ...init.body };
  classes = [...classes, created];
  return Promise.resolve({ data: created });
});
const patchMock = mock((_path: string, init: { body: Record<string, unknown> }) => {
  classes = [{ ...CLASS, ...init.body }];
  return Promise.resolve<unknown>({ data: classes[0] });
});
const deleteMock = mock((_path: string, _init?: unknown) => {
  classes = [];
  return Promise.resolve<unknown>({ data: undefined });
});
mock.module("../../../lib/api", () => ({
  api: { GET: getMock, POST: postMock, PATCH: patchMock, DELETE: deleteMock },
}));

async function renderAs(role: string) {
  const Page: ComponentType = (await import("./PrincipalClassesPage")).default;
  const store = await createTestSessionStore([role]);
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

/** Opens the `Select` labelled `label` inside `scope` and picks the option named `option`. */
async function choose(scope: HTMLElement, label: RegExp, option: string) {
  const combobox = within(scope).getByRole("combobox", { name: label }) as HTMLButtonElement;
  await waitFor(() => expect(combobox.disabled).toBe(false));
  fireEvent.click(combobox);
  fireEvent.click(await within(scope).findByRole("option", { name: option }));
}

afterEach(() => {
  cleanup();
  classes = [CLASS];
  subjects = [SUBJECT];
  courses = [COURSE];
  getMock.mockClear();
  postMock.mockClear();
  patchMock.mockClear();
  deleteMock.mockClear();
});

describe("PrincipalClassesPage", () => {
  test("adds a class in the selected year and term", async () => {
    await renderAs("PRINCIPAL");

    fireEvent.click(await screen.findByRole("button", { name: "Add class" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a class" });
    await choose(dialog, /^Course/, "MATH101 – Algebra I");
    await choose(dialog, /^Lead teacher/, "Ada Lovelace");
    await choose(dialog, /^Grade section/, "Grade 10 – C");
    fireEvent.change(within(dialog).getByRole("textbox", { name: /^Class code/ }), {
      target: { value: " MATH-102 " },
    });
    fireEvent.change(within(dialog).getByRole("spinbutton", { name: /^Capacity/ }), {
      target: { value: "25" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add class" }));

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith("/api/academics/classes", {
        body: {
          course_id: "course-1",
          academic_year_id: "year-1",
          term_id: "term-1",
          lead_teacher_id: "teacher-1",
          code: "MATH-102",
          capacity: 25,
          status: "planned",
          section_id: "sec-10c",
        },
      }),
    );
    await screen.findByText("Class added");
    expect(await screen.findByRole("cell", { name: "MATH-102" })).toBeTruthy();
  });

  test("explains a duplicate class code", async () => {
    postMock.mockImplementationOnce(() =>
      Promise.reject(
        new ApiError({
          status: 409,
          title: "Conflict",
          code: "CONFLICT_DUPLICATE_ENTRY",
          detail: "duplicate key",
          instance: null,
          type: null,
          request_id: null,
          problem: null,
        }),
      ),
    );
    await renderAs("PRINCIPAL");

    fireEvent.click(await screen.findByRole("button", { name: "Add class" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a class" });
    await choose(dialog, /^Course/, "MATH101 – Algebra I");
    await choose(dialog, /^Lead teacher/, "Ada Lovelace");
    fireEvent.change(within(dialog).getByRole("textbox", { name: /^Class code/ }), {
      target: { value: "MATH-101" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add class" }));

    expect(
      await screen.findByText(
        'A class with the code "MATH-101" already exists. Choose another code.',
      ),
    ).toBeTruthy();
    // The form stays open so the code can be fixed.
    expect(screen.getByRole("dialog", { name: "Add a class" })).toBeTruthy();
  });

  test("edits a class, sending only the changed fields, and lists its new section", async () => {
    await renderAs("PRINCIPAL");

    fireEvent.click(await screen.findByRole("button", { name: "Edit MATH-101" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit MATH-101" });
    // Prefilled from the class.
    expect(
      (within(dialog).getByRole("textbox", { name: /^Class code/ }) as HTMLInputElement).value,
    ).toBe("MATH-101");
    // A class's course can't change once it exists.
    expect(
      (within(dialog).getByRole("combobox", { name: /^Course/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(within(dialog).queryByRole("button", { name: "Add new course" })).toBeNull();
    const save = within(dialog).getByRole("button", { name: "Save changes" });
    expect((save as HTMLButtonElement).disabled).toBe(true);

    await choose(dialog, /^Grade section/, "Grade 10 – C");
    fireEvent.change(within(dialog).getByRole("spinbutton", { name: /^Capacity/ }), {
      target: { value: "30" },
    });
    fireEvent.click(save);

    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith("/api/academics/classes/{classId}", {
        params: { path: { classId: "class-1" } },
        body: { capacity: 30, section_id: "sec-10c" },
      }),
    );
    expect(await screen.findByRole("cell", { name: "Grade 10 – C" })).toBeTruthy();
  });

  test("deletes a class after confirming", async () => {
    await renderAs("ORG_ADMIN");

    fireEvent.click(await screen.findByRole("button", { name: "Delete MATH-101" }));
    const confirm = await screen.findByRole("dialog", { name: "Delete MATH-101?" });
    expect(within(confirm).getByText(/cancelled instead of deleted/)).toBeTruthy();
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(deleteMock).toHaveBeenCalledWith("/api/academics/classes/{classId}", {
        params: { path: { classId: "class-1" } },
      }),
    );
    await screen.findByText("Class removed");
  });

  test("shows the list read-only to a session without timetable:manage", async () => {
    classes = [{ ...CLASS, section_id: "sec-10c" }];
    await renderAs("INSTRUCTOR");

    expect(await screen.findByRole("cell", { name: "Grade 10 – C" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add class" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit MATH-101" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete MATH-101" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Import/ })).toBeNull();
    expect(screen.queryByRole("link", { name: "Grades & sections" })).toBeNull();
    // Classes are scheduled by grade section; rooms aren't part of the list.
    expect(screen.queryByRole("columnheader", { name: "Room" })).toBeNull();
  });

  test("offers the import and the sections link to a principal, and passes an accessibility check", async () => {
    const { container } = await renderAs("PRINCIPAL");

    expect(await screen.findByRole("button", { name: /Import/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Grades & sections" }).getAttribute("href")).toBe(
      "/portal/principal/sections",
    );
    await screen.findByRole("button", { name: "Edit MATH-101" });
    await expectNoA11yViolations(container);

    fireEvent.click(screen.getByRole("button", { name: "Add class" }));
    await screen.findByRole("dialog", { name: "Add a class" });
    await expectNoA11yViolations(container);
  });
});

describe("AddCourseModal", () => {
  test("creates a subject and a course, then selects the course in the class form", async () => {
    await renderAs("PRINCIPAL");

    fireEvent.click(await screen.findByRole("button", { name: "Add class" }));
    const form = await screen.findByRole("dialog", { name: "Add a class" });
    fireEvent.click(within(form).getByRole("button", { name: "Add new course" }));

    const dialog = await screen.findByRole("dialog", { name: "Add a course" });
    await choose(dialog, /^Subject/, "New subject…");
    fireEvent.change(within(dialog).getByRole("textbox", { name: /^Subject name/ }), {
      target: { value: "Physics" },
    });
    fireEvent.change(within(dialog).getByRole("textbox", { name: /^Subject code/ }), {
      target: { value: "PHY" },
    });
    fireEvent.change(within(dialog).getByRole("textbox", { name: /^Course name/ }), {
      target: { value: "Mechanics" },
    });
    fireEvent.change(within(dialog).getByRole("textbox", { name: /^Course code/ }), {
      target: { value: "PHY101" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add course" }));

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith("/api/academics/subjects/{subjectId}/courses", {
        params: { path: { subjectId: "subject-2" } },
        body: {
          subject_id: "subject-2",
          code: "PHY101",
          name: "Mechanics",
          status: "active",
          credit_hours: 1,
        },
      }),
    );
    expect(postMock).toHaveBeenCalledWith("/api/academics/subjects", {
      body: { code: "PHY", name: "Physics", status: "active" },
    });

    // Back on the class form, with the new course chosen.
    const back = await screen.findByRole("dialog", { name: "Add a class" });
    await waitFor(() =>
      expect(within(back).getByRole("combobox", { name: /^Course/ }).textContent).toContain(
        "PHY101 – Mechanics",
      ),
    );
  });

  test("adds a course to an existing subject", async () => {
    await renderAs("PRINCIPAL");

    fireEvent.click(await screen.findByRole("button", { name: "Add class" }));
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: "Add a class" })).getByRole("button", {
        name: "Add new course",
      }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Add a course" });
    await choose(dialog, /^Subject/, "Mathematics (MATH)");
    expect(within(dialog).queryByRole("textbox", { name: /^Subject name/ })).toBeNull();
    fireEvent.change(within(dialog).getByRole("textbox", { name: /^Course name/ }), {
      target: { value: "Geometry" },
    });
    fireEvent.change(within(dialog).getByRole("textbox", { name: /^Course code/ }), {
      target: { value: "MATH201" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add course" }));

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith("/api/academics/subjects/{subjectId}/courses", {
        params: { path: { subjectId: "subject-1" } },
        body: {
          subject_id: "subject-1",
          code: "MATH201",
          name: "Geometry",
          status: "active",
          credit_hours: 1,
        },
      }),
    );
    expect(postMock).not.toHaveBeenCalledWith("/api/academics/subjects", expect.anything());
  });
});
