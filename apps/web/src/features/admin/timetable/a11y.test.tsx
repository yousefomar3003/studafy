import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import { AuthProvider, createSessionStore } from "../../../lib/auth";
import { expectNoA11yViolations } from "../../../lib/test/axe";

import type { SessionTokens } from "../../../lib/auth";
import type { ComponentType } from "react";

/** Automated accessibility audit for the timetable builder, mirroring `admin/students/a11y.test.tsx`
 * — one render per representative state: empty, the create-draft dialog, a draft grid with a slot
 * already placed, and that slot's edit dialog. */

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

const VERSION = {
  id: "version-1",
  school_id: "school-1",
  academic_year_id: "year-1",
  term_id: "term-1",
  name: "Term 1 Weekly Schedule",
  status: "draft" as const,
  submitted_at: null,
  submitted_by_user_id: null,
  approved_at: null,
  approved_by_user_id: null,
  rejected_reason: null,
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

const SLOT_A = {
  id: "slot-1",
  school_id: "school-1",
  timetable_version_id: "version-1",
  class_id: "class-a",
  teacher_id: "teacher-1",
  room_id: "room-1",
  weekday: 1,
  period: 1,
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z",
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

function getMockImplementation(withVersion: boolean, withSlot: boolean) {
  return (path: string) => {
    if (path === "/api/academics/years") {
      return Promise.resolve<unknown>({ data: { academic_years: [YEAR], total: 1 } });
    }
    if (path === "/api/academics/years/{yearId}/terms") {
      return Promise.resolve<unknown>({ data: { terms: [TERM], total: 1 } });
    }
    if (path === "/api/academics/timetable-versions") {
      return Promise.resolve<unknown>({
        data: {
          timetable_versions: withVersion ? [VERSION] : [],
          total: withVersion ? 1 : 0,
        },
      });
    }
    if (path === "/api/academics/timetable-versions/{versionId}/slots") {
      return Promise.resolve<unknown>({
        data: { timetable_slots: withSlot ? [SLOT_A] : [], total: withSlot ? 1 : 0 },
      });
    }
    if (path === "/api/academics/classes") {
      return Promise.resolve<unknown>({ data: { classes: [CLASS_A], total: 1 } });
    }
    if (path === "/api/teachers") {
      return Promise.resolve<unknown>({ data: { teachers: [TEACHER_PROFILE], next_cursor: null } });
    }
    if (path === "/api/users") {
      return Promise.resolve<unknown>({ data: { users: [INSTRUCTOR_USER], next_cursor: null } });
    }
    if (path === "/api/academics/rooms") {
      return Promise.resolve<unknown>({ data: { rooms: [ROOM_1], total: 1 } });
    }
    throw new Error(`Unhandled GET ${path}`);
  };
}

const getMock = mock(getMockImplementation(true, true));
const postMock = mock((_path: string, _init?: unknown) => Promise.resolve<unknown>({ data: {} }));
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
  deleteMock.mockClear();
});

describe("timetable builder accessibility", () => {
  test("no versions yet", async () => {
    getMock.mockImplementation(getMockImplementation(false, false));
    const { container } = await renderAsOrgAdmin(await loadPage());
    await screen.findByText("Create a draft version to start building this term's schedule.");

    await expectNoA11yViolations(container);
  });

  test("new-draft modal open", async () => {
    getMock.mockImplementation(getMockImplementation(false, false));
    const { container } = await renderAsOrgAdmin(await loadPage());
    // Waiting for this text (rather than just the button's presence) guarantees the term has
    // finished auto-selecting and the "New draft" button is no longer disabled.
    await screen.findByText("Create a draft version to start building this term's schedule.");

    fireEvent.click(screen.getByRole("button", { name: "New draft" }));
    await screen.findByRole("dialog", { name: "New draft timetable" });

    await expectNoA11yViolations(container);
  });

  test("draft grid with a placed slot", async () => {
    getMock.mockImplementation(getMockImplementation(true, true));
    const { container } = await renderAsOrgAdmin(await loadPage());
    await screen.findByRole("button", { name: /MATH-101, Monday period 1/ });

    await expectNoA11yViolations(container);
  });

  test("edit-slot modal open", async () => {
    getMock.mockImplementation(getMockImplementation(true, true));
    const { container } = await renderAsOrgAdmin(await loadPage());
    const slotButton = await screen.findByRole("button", { name: /MATH-101, Monday period 1/ });

    fireEvent.click(slotButton);
    await screen.findByRole("dialog", { name: "Edit slot" });

    await expectNoA11yViolations(container);
  });
});
