import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import { AuthProvider, createSessionStore } from "../../../lib/auth";

import type { SessionTokens } from "../../../lib/auth";
import type { ComponentType } from "react";

/**
 * Interaction coverage for the timetable workspace: create a term's first timetable, place a class via
 * the pick-then-place keyboard path (native HTML5 drag events aren't simulable in happy-dom, so this
 * exercises the keyboard-equivalent path — see `TimetableGrid.tsx`'s doc comment for why both funnel
 * through the same `assignSlot`), add a lesson from an empty cell, see a conflict render, publish;
 * then edit a live timetable through a draft copy and discard it; change the school week; and narrow
 * the grid to a grade and one of its sections, where a section double-booking is flagged.
 */

const YEAR = {
  id: "year-1",
  school_id: "school-1",
  code: "2025-2026",
  name: "2025-2026",
  starts_on: "2025-09-01",
  ends_on: "2026-06-30",
  status: "active" as const,
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z",
};

const TERM = {
  id: "term-1",
  school_id: "school-1",
  academic_year_id: "year-1",
  code: "T1",
  name: "Term 1",
  sequence_number: 1,
  starts_on: "2025-09-01",
  ends_on: "2026-01-15",
  status: "active" as const,
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z",
};

const CLASS_A = {
  id: "class-a",
  school_id: "school-1",
  course_id: "course-1",
  academic_year_id: "year-1",
  term_id: "term-1",
  lead_teacher_id: "teacher-1",
  room_id: null,
  section_id: "sec-10c",
  code: "MATH-101",
  capacity: 30,
  status: "active" as const,
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z",
};

const CLASS_B = {
  ...CLASS_A,
  id: "class-b",
  section_id: "sec-11a",
  code: "SCI-201",
};

/** Same section as MATH-101 but another teacher, so placing both at once is only a section
 * double-booking, not a teacher clash. */
const CLASS_C = {
  ...CLASS_A,
  id: "class-c",
  lead_teacher_id: "teacher-2",
  code: "ENG-101",
};

const CLASSES = [CLASS_A, CLASS_B, CLASS_C];

const GRADE_10 = {
  id: "grade-10",
  school_id: "school-1",
  name: "Grade 10",
  sort_order: 10,
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z",
};
const GRADE_11 = { ...GRADE_10, id: "grade-11", name: "Grade 11", sort_order: 11 };

const SECTION_10C = {
  id: "sec-10c",
  school_id: "school-1",
  academic_year_id: "year-1",
  grade_level_id: "grade-10",
  grade_level_name: "Grade 10",
  name: "C",
  student_count: 0,
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z",
};
const SECTION_11A = {
  ...SECTION_10C,
  id: "sec-11a",
  grade_level_id: "grade-11",
  grade_level_name: "Grade 11",
  name: "A",
};
const SECTIONS = [SECTION_10C, SECTION_11A];

const TEACHER_PROFILE = {
  id: "teacher-1",
  school_id: "school-1",
  user_id: "user-t1",
  employee_number: "EMP-001",
  employment_status: "active" as const,
  hire_date: null,
  termination_date: null,
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z",
};

const INSTRUCTOR_USER = {
  id: "user-t1",
  school_id: "school-1",
  email: "chen@example.edu",
  display_name: "Ms. Chen",
  status: "active" as const,
  roles: ["INSTRUCTOR"],
  email_verified_at: null,
  last_login_at: null,
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z",
};

interface State {
  versions: Record<string, unknown>[];
  slots: Map<string, Record<string, unknown>[]>;
  settings: { school_days: number[]; periods_per_day: number };
}

function freshState(): State {
  return {
    versions: [],
    slots: new Map(),
    settings: { school_days: [7, 1, 2, 3, 4], periods_per_day: 4 },
  };
}

let state = freshState();

function version(overrides: Record<string, unknown>) {
  return {
    id: "version-1",
    school_id: "school-1",
    academic_year_id: "year-1",
    term_id: "term-1",
    name: "Term 1 timetable",
    status: "draft",
    submitted_at: null,
    submitted_by_user_id: null,
    approved_at: null,
    approved_by_user_id: null,
    rejected_reason: null,
    created_at: "2026-08-16T00:00:00.000Z",
    updated_at: "2026-08-16T00:00:00.000Z",
    ...overrides,
  };
}

/** A slot as the API returns it: carrying its class's section and that section's grade. */
function slot(versionId: string, index: number, body: Record<string, unknown>) {
  const sectionId = CLASSES.find((klass) => klass.id === body.class_id)?.section_id ?? null;
  const section = SECTIONS.find((candidate) => candidate.id === sectionId);
  return {
    id: `${versionId}-slot-${index}`,
    school_id: "school-1",
    timetable_version_id: versionId,
    room_id: null,
    section_id: section?.id ?? null,
    section_name: section?.name ?? null,
    grade_level_name: section?.grade_level_name ?? null,
    created_at: "2026-08-16T00:00:00.000Z",
    updated_at: "2026-08-16T00:00:00.000Z",
    ...body,
  };
}

function getMockImplementation(
  path: string,
  init?: { params?: { path?: { versionId?: string } } },
) {
  if (path === "/api/academics/years") {
    return Promise.resolve<unknown>({ data: { academic_years: [YEAR], total: 1 } });
  }
  if (path === "/api/academics/years/{yearId}/terms") {
    return Promise.resolve<unknown>({ data: { terms: [TERM], total: 1 } });
  }
  if (path === "/api/academics/timetable-versions") {
    return Promise.resolve<unknown>({
      data: { timetable_versions: state.versions, total: state.versions.length },
    });
  }
  if (path === "/api/academics/timetable-versions/{versionId}/slots") {
    const slots = state.slots.get(init?.params?.path?.versionId ?? "") ?? [];
    return Promise.resolve<unknown>({ data: { timetable_slots: slots, total: slots.length } });
  }
  if (path === "/api/academics/timetable-settings") {
    return Promise.resolve<unknown>({ data: state.settings });
  }
  if (path === "/api/academics/classes") {
    return Promise.resolve<unknown>({ data: { classes: CLASSES, total: CLASSES.length } });
  }
  if (path === "/api/academics/grade-levels") {
    return Promise.resolve<unknown>({ data: { grade_levels: [GRADE_10, GRADE_11], total: 2 } });
  }
  if (path === "/api/academics/sections") {
    return Promise.resolve<unknown>({ data: { sections: SECTIONS, total: SECTIONS.length } });
  }
  if (path === "/api/teachers") {
    return Promise.resolve<unknown>({ data: { teachers: [TEACHER_PROFILE], next_cursor: null } });
  }
  if (path === "/api/users") {
    return Promise.resolve<unknown>({ data: { users: [INSTRUCTOR_USER], next_cursor: null } });
  }
  throw new Error(`Unhandled GET ${path}`);
}

function postMockImplementation(
  path: string,
  init?: { body?: Record<string, unknown>; params?: { path?: { versionId?: string } } },
) {
  const body = init?.body ?? {};
  const versionId = init?.params?.path?.versionId ?? "";
  if (path === "/api/academics/timetable-versions") {
    const created = version({ id: "draft-1", name: body.name });
    state.versions = [...state.versions, created];
    return Promise.resolve<unknown>({ data: created });
  }
  if (path === "/api/academics/timetable-versions/copy") {
    const created = version({ id: "draft-copy", name: body.name });
    state.versions = [...state.versions, created];
    const source = state.slots.get(String(body.source_version_id)) ?? [];
    state.slots.set(
      "draft-copy",
      source.map((row, index) => ({
        ...row,
        id: `draft-copy-slot-${index + 1}`,
        timetable_version_id: "draft-copy",
      })),
    );
    return Promise.resolve<unknown>({
      data: { timetable_version: created, slots_copied: source.length, slots_skipped: 0 },
    });
  }
  if (path === "/api/academics/timetable-versions/{versionId}/slots") {
    const existing = state.slots.get(versionId) ?? [];
    const created = slot(versionId, existing.length + 1, body);
    state.slots.set(versionId, [...existing, created]);
    return Promise.resolve<unknown>({ data: created });
  }
  if (path === "/api/academics/timetable-versions/{versionId}/publish") {
    state.versions = state.versions.map((candidate) =>
      candidate.id === versionId
        ? { ...candidate, status: "approved", approved_at: "2026-09-01T08:00:00.000Z" }
        : candidate,
    );
    return Promise.resolve<unknown>({
      data: state.versions.find((candidate) => candidate.id === versionId),
    });
  }
  throw new Error(`Unhandled POST ${path}`);
}

function deleteMockImplementation(
  path: string,
  init?: { params?: { path?: { versionId?: string; slotId?: string } } },
) {
  if (path === "/api/academics/slots/{slotId}") {
    const slotId = init?.params?.path?.slotId;
    for (const [versionId, rows] of state.slots) {
      state.slots.set(
        versionId,
        rows.filter((row) => row.id !== slotId),
      );
    }
    return Promise.resolve<unknown>({ data: undefined });
  }
  if (path === "/api/academics/timetable-versions/{versionId}") {
    const versionId = init?.params?.path?.versionId;
    state.versions = state.versions.filter((candidate) => candidate.id !== versionId);
    return Promise.resolve<unknown>({ data: undefined });
  }
  throw new Error(`Unhandled DELETE ${path}`);
}

function putMockImplementation(path: string, init?: { body?: State["settings"] }) {
  if (path === "/api/academics/timetable-settings" && init?.body) {
    state.settings = init.body;
    return Promise.resolve<unknown>({ data: state.settings });
  }
  throw new Error(`Unhandled PUT ${path}`);
}

const getMock = mock(getMockImplementation);
const postMock = mock(postMockImplementation);
const patchMock = mock((_path: string, _init?: unknown) => Promise.resolve<unknown>({ data: {} }));
const deleteMock = mock(deleteMockImplementation);
const putMock = mock(putMockImplementation);

mock.module("../../../lib/api", () => ({
  api: { GET: getMock, POST: postMock, PATCH: patchMock, DELETE: deleteMock, PUT: putMock },
}));

const loadPage = async (): Promise<ComponentType> =>
  (await import("./TimetableBuilderPage")).default;

/** Builds a JWT-shaped string (header.payload.signature), unsigned — matches
 * `require-permission.test.tsx` and `access-token-claims.test.ts`. */
function fakeJwt(payload: unknown): string {
  const segment = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${segment({ alg: "RS256" })}.${segment(payload)}.signature`;
}

async function renderAs(Page: ComponentType, role: string) {
  const store = createSessionStore({
    refreshClient: {
      refresh: async (): Promise<SessionTokens> => ({
        accessToken: fakeJwt({ roles: [role] }),
        expiresAt: Date.now() + 3_600_000,
        sessionId: "session-1",
      }),
      logout: async () => undefined,
    },
  });
  await store.restore();

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <AuthProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <MemoryRouter>
            <Page />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>
    </AuthProvider>,
  );
}

/** A live (approved) version with one MATH-101 lesson on Sunday period 1. */
function seedLiveTimetable() {
  state.versions = [
    version({ id: "live-1", status: "approved", approved_at: "2026-08-20T08:00:00.000Z" }),
  ];
  state.slots.set("live-1", [
    slot("live-1", 1, {
      class_id: "class-a",
      teacher_id: "teacher-1",
      weekday: 7,
      period: 1,
    }),
  ]);
}

afterEach(() => {
  cleanup();
  state = freshState();
  getMock.mockClear();
  postMock.mockClear();
  patchMock.mockClear();
  deleteMock.mockClear();
  putMock.mockClear();
});

describe("TimetableBuilderPage", () => {
  test("creates a term's first timetable, places and adds lessons, surfaces a conflict, and publishes", async () => {
    const Page = await loadPage();
    await renderAs(Page, "ORG_ADMIN");

    await screen.findByText("No timetable for this term yet");
    fireEvent.click(screen.getByRole("button", { name: "Create timetable" }));

    await screen.findByText(/building this term's first timetable/);
    expect(postMock).toHaveBeenCalledWith("/api/academics/timetable-versions", {
      body: { term_id: "term-1", academic_year_id: "year-1", name: "Term 1 timetable" },
    });

    // Only the school week's days are columns: Sunday–Thursday by default.
    const table = await screen.findByRole("table");
    const headers = within(table)
      .getAllByRole("columnheader")
      .map((cell) => cell.textContent);
    expect(headers).toEqual(["Period", "Sun", "Mon", "Tue", "Wed", "Thu"]);

    // Pick-then-place a class with the keyboard-equivalent path.
    fireEvent.click(await screen.findByRole("button", { name: "MATH-101" }));
    fireEvent.click(screen.getByRole("button", { name: "Place MATH-101 on Sunday period 1" }));
    await screen.findByRole("button", { name: /MATH-101, Sunday period 1/ });

    // Same teacher, same time: caught locally before any request.
    const postsBefore = postMock.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "SCI-201" }));
    fireEvent.click(screen.getByRole("button", { name: "Place SCI-201 on Sunday period 1" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain('Teacher "Ms. Chen" is already scheduled');
    expect(postMock.mock.calls.length).toBe(postsBefore);
    fireEvent.click(screen.getByRole("button", { name: "SCI-201" })); // put it back down

    // Add a lesson from an empty cell through the form.
    fireEvent.click(screen.getByRole("button", { name: "Add a lesson on Monday period 2" }));
    const dialog = await screen.findByRole("dialog", { name: "Add lesson" });
    fireEvent.click(within(dialog).getByRole("combobox", { name: /^Class/ }));
    fireEvent.click(screen.getByRole("option", { name: "SCI-201" }));
    // Lessons are scheduled per class and section only — there's no room to pick.
    expect(within(dialog).queryByRole("combobox", { name: /^Room/ })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Add lesson" }));
    await screen.findByRole("button", { name: /SCI-201, Monday period 2/ });
    expect(postMock).toHaveBeenCalledWith("/api/academics/timetable-versions/{versionId}/slots", {
      params: { path: { versionId: "draft-1" } },
      body: { class_id: "class-b", teacher_id: "teacher-1", weekday: 1, period: 2 },
    });

    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    await screen.findByText(/Teachers and students are following this timetable/);
    expect(postMock).toHaveBeenCalledWith("/api/academics/timetable-versions/{versionId}/publish", {
      params: { path: { versionId: "draft-1" } },
    });
    // Published: read-only, with an edit entry point instead of the class palette.
    expect(screen.queryByRole("button", { name: "MATH-101" })).toBeNull();
    expect(screen.getByRole("button", { name: "Edit timetable" })).toBeTruthy();
  });

  test("edits the live timetable through a draft copy and discards it", async () => {
    seedLiveTimetable();
    const Page = await loadPage();
    await renderAs(Page, "PRINCIPAL");

    await screen.findByRole("button", { name: /MATH-101, Sunday period 1/ });
    fireEvent.click(screen.getByRole("button", { name: "Edit timetable" }));

    await screen.findByText(/You're editing a draft/);
    expect(postMock).toHaveBeenCalledWith("/api/academics/timetable-versions/copy", {
      body: {
        source_version_id: "live-1",
        term_id: "term-1",
        academic_year_id: "year-1",
        // The live version keeps its name, so the draft takes the next free one.
        name: "Term 1 timetable (2)",
      },
    });
    // The copy carries the live lessons into the draft, now editable.
    const lesson = await screen.findByRole("button", { name: /MATH-101, Sunday period 1/ });
    expect((lesson as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    const confirm = await screen.findByRole("dialog", { name: "Discard this draft?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Discard draft" }));

    await waitFor(() =>
      expect(deleteMock).toHaveBeenCalledWith("/api/academics/timetable-versions/{versionId}", {
        params: { path: { versionId: "draft-copy" }, query: { discard_slots: "true" } },
      }),
    );
    await screen.findByText(/Teachers and students are following this timetable/);
  });

  test("removes a lesson from a draft and the grid drops it", async () => {
    seedLiveTimetable();
    const Page = await loadPage();
    await renderAs(Page, "ORG_ADMIN");

    await screen.findByRole("button", { name: /MATH-101, Sunday period 1/ });
    fireEvent.click(screen.getByRole("button", { name: "Edit timetable" }));
    await screen.findByText(/You're editing a draft/);

    const lesson = await screen.findByRole("button", { name: /MATH-101, Sunday period 1/ });
    await waitFor(() => expect((lesson as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(lesson);
    const dialog = await screen.findByRole("dialog", { name: "Edit slot" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));

    await screen.findByText("Slot removed");
    expect(deleteMock).toHaveBeenCalledWith("/api/academics/slots/{slotId}", {
      params: { path: { slotId: "draft-copy-slot-1" } },
    });
    // The refetch after the delete drops the lesson from the grid.
    await screen.findByText(/0 lessons a week/);
    expect(screen.queryAllByRole("button", { name: /MATH-101, Sunday period 1/ })).toHaveLength(0);
  });

  test("viewers without timetable:manage get the live timetable read-only", async () => {
    seedLiveTimetable();
    const Page = await loadPage();
    await renderAs(Page, "INSTRUCTOR");

    const lesson = await screen.findByRole("button", { name: /MATH-101, Sunday period 1/ });
    expect((lesson as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Edit timetable" })).toBeNull();
    expect(screen.queryByRole("button", { name: "School week" })).toBeNull();
  });

  test("changes the school week, which reshapes the grid", async () => {
    seedLiveTimetable();
    const Page = await loadPage();
    await renderAs(Page, "ORG_ADMIN");

    await screen.findByRole("table");
    fireEvent.click(screen.getByRole("button", { name: "School week" }));
    const dialog = await screen.findByRole("dialog", { name: "School week" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Monday–Friday" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save school week" }));

    await waitFor(() =>
      expect(putMock).toHaveBeenCalledWith("/api/academics/timetable-settings", {
        body: { school_days: [1, 2, 3, 4, 5], periods_per_day: 4 },
      }),
    );
    // Sunday left the school week but keeps its column while it still has a lesson.
    await waitFor(() => {
      const headers = within(screen.getByRole("table"))
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent);
      expect(headers).toEqual(["Period", "Mon", "Tue", "Wed", "Thu", "Fri", "Sun"]);
    });
  });
  test("narrows the grid to a grade and section, and flags a section double-booking", async () => {
    // A draft with MATH-101 (Grade 10 – C) on Sunday period 1 and SCI-201 (Grade 11 – A) on Monday.
    state.versions = [version({ id: "draft-1" })];
    state.slots.set("draft-1", [
      slot("draft-1", 1, {
        class_id: "class-a",
        teacher_id: "teacher-1",
        weekday: 7,
        period: 1,
      }),
      slot("draft-1", 2, {
        class_id: "class-b",
        teacher_id: "teacher-1",
        weekday: 1,
        period: 1,
      }),
    ]);
    const Page = await loadPage();
    await renderAs(Page, "ORG_ADMIN");

    // Unfiltered, each lesson names its section; the section filter waits for a grade.
    await screen.findByRole("button", { name: /MATH-101, Sunday period 1, section 10-C/ });
    expect(
      screen.getByRole("button", { name: /SCI-201, Monday period 1, section 11-A/ }),
    ).toBeTruthy();
    const sectionSelect = screen.getByRole("combobox", { name: /^Section/ });
    expect((sectionSelect as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("combobox", { name: /^Grade/ }));
    fireEvent.click(await screen.findByRole("option", { name: "Grade 10" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /SCI-201, Monday period 1/ })).toBeNull(),
    );
    expect(screen.getByRole("button", { name: /MATH-101, Sunday period 1/ })).toBeTruthy();

    // A section: its lessons only, its classes only in the palette, no redundant section labels.
    fireEvent.click(screen.getByRole("combobox", { name: /^Section/ }));
    fireEvent.click(await screen.findByRole("option", { name: "C" }));
    const lesson = await screen.findByRole("button", { name: /MATH-101, Sunday period 1/ });
    expect(lesson.getAttribute("aria-label")).not.toContain("section");
    expect(screen.queryByRole("button", { name: "SCI-201" })).toBeNull();
    expect(screen.getByRole("button", { name: "ENG-101" })).toBeTruthy();

    // ENG-101 has its own teacher, so it places — and the section clash is flagged.
    fireEvent.click(screen.getByRole("button", { name: "ENG-101" }));
    fireEvent.click(screen.getByRole("button", { name: "Place ENG-101 on Sunday period 1" }));
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith("/api/academics/timetable-versions/{versionId}/slots", {
        params: { path: { versionId: "draft-1" } },
        body: {
          class_id: "class-c",
          teacher_id: "teacher-2",
          weekday: 7,
          period: 1,
        },
      }),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      (await screen.findByText(/Section "Grade 10 – C" also has class "MATH-101"/)).textContent,
    ).toContain("Sunday, period 1");

    // A section with a single class preselects it in the add-lesson form.
    fireEvent.click(screen.getByRole("combobox", { name: /^Grade/ }));
    fireEvent.click(await screen.findByRole("option", { name: "Grade 11" }));
    fireEvent.click(screen.getByRole("combobox", { name: /^Section/ }));
    fireEvent.click(await screen.findByRole("option", { name: "A" }));
    fireEvent.click(screen.getByRole("button", { name: "Add a lesson on Tuesday period 2" }));
    const dialog = await screen.findByRole("dialog", { name: "Add lesson" });
    expect(within(dialog).getByRole("combobox", { name: /^Class/ }).textContent).toBe("SCI-201");
  });
});
