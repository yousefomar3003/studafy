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
 * Interaction coverage for the timetable builder: create a draft, place a class via the
 * pick-then-place keyboard path (native HTML5 drag events aren't simulable in happy-dom, so this
 * exercises the keyboard-equivalent path — see `TimetableGrid.tsx`'s doc comment for why both funnel
 * through the same `assignSlot`), see a conflict render at drop-time, then submit for review. The
 * actual build→submit user journey (acceptance criterion) also has Playwright coverage in
 * `apps/web/e2e/timetable-builder.spec.ts`.
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
  room_id: "room-1",
  code: "MATH-101",
  capacity: 30,
  status: "active" as const,
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z",
};

const CLASS_B = {
  ...CLASS_A,
  id: "class-b",
  room_id: "room-2",
  code: "SCI-201",
};

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

const ROOM_1 = {
  id: "room-1",
  school_id: "school-1",
  code: "RM-101",
  name: "Room 101",
  room_type: "physical" as const,
  capacity: 30,
  building: "Main",
  floor: "1",
  virtual_url: null,
  is_active: true,
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z",
};

const ROOM_2 = { ...ROOM_1, id: "room-2", code: "RM-102", name: "Room 102" };

interface State {
  versions: Record<string, unknown>[];
  slots: Record<string, unknown>[];
}

function freshState(): State {
  return { versions: [], slots: [] };
}

let state = freshState();

function getMockImplementation(path: string) {
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
    return Promise.resolve<unknown>({
      data: { timetable_slots: state.slots, total: state.slots.length },
    });
  }
  if (path === "/api/academics/classes") {
    return Promise.resolve<unknown>({ data: { classes: [CLASS_A, CLASS_B], total: 2 } });
  }
  if (path === "/api/teachers") {
    return Promise.resolve<unknown>({ data: { teachers: [TEACHER_PROFILE], next_cursor: null } });
  }
  if (path === "/api/users") {
    return Promise.resolve<unknown>({ data: { users: [INSTRUCTOR_USER], next_cursor: null } });
  }
  if (path === "/api/academics/rooms") {
    return Promise.resolve<unknown>({ data: { rooms: [ROOM_1, ROOM_2], total: 2 } });
  }
  throw new Error(`Unhandled GET ${path}`);
}

function postMockImplementation(path: string, init?: { body?: Record<string, unknown> }) {
  if (path === "/api/academics/timetable-versions") {
    const body = init?.body ?? {};
    const version = {
      id: "version-1",
      school_id: "school-1",
      academic_year_id: body.academic_year_id,
      term_id: body.term_id,
      name: body.name,
      status: "draft" as const,
      submitted_at: null,
      submitted_by_user_id: null,
      approved_at: null,
      approved_by_user_id: null,
      rejected_reason: null,
      created_at: "2026-08-16T00:00:00.000Z",
      updated_at: "2026-08-16T00:00:00.000Z",
    };
    state.versions = [version];
    return Promise.resolve<unknown>({ data: version });
  }
  if (path === "/api/academics/timetable-versions/{versionId}/slots") {
    const body = init?.body ?? {};
    const slot = {
      id: `slot-${state.slots.length + 1}`,
      school_id: "school-1",
      timetable_version_id: "version-1",
      class_id: body.class_id,
      teacher_id: body.teacher_id,
      room_id: body.room_id,
      weekday: body.weekday,
      period: body.period,
      created_at: "2026-08-16T00:00:00.000Z",
      updated_at: "2026-08-16T00:00:00.000Z",
    };
    state.slots = [...state.slots, slot];
    return Promise.resolve<unknown>({ data: slot });
  }
  if (path === "/api/academics/timetable-versions/{versionId}/submit") {
    state.versions = state.versions.map((version) => ({ ...version, status: "pending" }));
    return Promise.resolve<unknown>({ data: state.versions[0] });
  }
  throw new Error(`Unhandled POST ${path}`);
}

const getMock = mock(getMockImplementation);
const postMock = mock(postMockImplementation);
const patchMock = mock((_path: string, _init?: unknown) => Promise.resolve<unknown>({ data: {} }));
const deleteMock = mock((_path: string, _init?: unknown) =>
  Promise.resolve<unknown>({ data: undefined }),
);

mock.module("../../../lib/api", () => ({
  api: { GET: getMock, POST: postMock, PATCH: patchMock, DELETE: deleteMock },
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

async function renderAsOrgAdmin(Page: ComponentType) {
  const store = createSessionStore({
    refreshClient: {
      refresh: async (): Promise<SessionTokens> => ({
        accessToken: fakeJwt({ roles: ["ORG_ADMIN"] }),
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

afterEach(() => {
  cleanup();
  state = freshState();
  getMock.mockClear();
  postMock.mockClear();
  patchMock.mockClear();
  deleteMock.mockClear();
});

describe("TimetableBuilderPage", () => {
  test("builds a draft — creates a version, places a class, surfaces a conflict, and submits it", async () => {
    await renderAsOrgAdmin(await loadPage());

    // Auto-selects the active year/term, then reports there's nothing to build yet.
    await screen.findByText("Create a draft version to start building this term's schedule.");

    // --- Draft versioning: create ---
    fireEvent.click(screen.getByRole("button", { name: "New draft" }));
    const createDialog = await screen.findByRole("dialog", { name: "New draft timetable" });
    fireEvent.change(within(createDialog).getByLabelText("Draft name", { exact: false }), {
      target: { value: "Term 1 Weekly Schedule" },
    });
    fireEvent.click(within(createDialog).getByRole("button", { name: "Create draft" }));

    // The status pill depends only on the versions query and can resolve before the grid's own
    // classes/teachers/rooms queries do, so each is awaited independently rather than assuming one
    // implies the other.
    await screen.findByText("Draft");
    await screen.findByRole("button", { name: "MATH-101" });
    expect(screen.getByRole("button", { name: "SCI-201" })).toBeTruthy();

    // --- Drag-assign (keyboard path): pick MATH-101, place it on Monday period 1 ---
    fireEvent.click(screen.getByRole("button", { name: "MATH-101" }));
    fireEvent.click(screen.getByRole("button", { name: "Place MATH-101 on Monday period 1" }));

    await waitFor(() => {
      const call = postMock.mock.calls.find(
        ([path]) => path === "/api/academics/timetable-versions/{versionId}/slots",
      );
      expect(call).toBeDefined();
    });
    await screen.findByRole("button", { name: /MATH-101, Monday period 1/ });

    // --- Conflict surfaces at drop-time: SCI-201 shares MATH-101's teacher ---
    postMock.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "SCI-201" }));
    fireEvent.click(screen.getByRole("button", { name: "Place SCI-201 on Monday period 1" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      'Teacher "Ms. Chen" is already scheduled for class "MATH-101" on Monday, period 1.',
    );
    // The conflict is caught client-side before any request goes out.
    expect(
      postMock.mock.calls.some(
        ([path]) => path === "/api/academics/timetable-versions/{versionId}/slots",
      ),
    ).toBe(false);

    // --- Submit for approval ---
    fireEvent.click(screen.getByRole("button", { name: "Submit for approval" }));

    await waitFor(() => {
      const call = postMock.mock.calls.find(
        ([path]) => path === "/api/academics/timetable-versions/{versionId}/submit",
      );
      expect(call).toBeDefined();
    });
    await screen.findByText("Submitted");
    await screen.findByText("This version is submitted and read-only.");
    // Read-only: the palette (and its "New draft"-adjacent editing affordances) is gone.
    expect(screen.queryByRole("button", { name: "MATH-101" })).toBeNull();
  });
});
