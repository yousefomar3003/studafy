import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import type { ComponentType } from "react";

/**
 * School members: counts of students, teachers and parents with the school's ID range, and a list
 * of each role's members with their member IDs.
 */

function user(id: string, name: string, role: string, code: string) {
  return {
    id,
    school_id: "00000000-0000-4000-8000-000000000001",
    email: `${name.toLowerCase()}@alpha.test`,
    display_name: name,
    status: "active",
    email_verified_at: null,
    last_login_at: null,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    roles: [role],
    member_codes: [code],
  };
}

const getMock = mock(
  (path: string, init?: { params: { query: { role: string; search?: string } } }) => {
    if (path === "/api/users/member-summary") {
      return Promise.resolve({
        data: {
          school_number: 1,
          students: 120,
          teachers: 12,
          parents: 95,
          attendance_officers: 3,
          default_password: "pass@1234",
        },
      });
    }
    if (path === "/api/users") {
      const rows =
        init?.params.query.role === "INSTRUCTOR"
          ? [user("22222222-2222-4222-8222-222222222222", "Omar", "INSTRUCTOR", "TCH-100001")]
          : [user("11111111-1111-4111-8111-111111111111", "Sara", "STUDENT", "STU-100001")];
      return Promise.resolve({ data: { users: rows, next_cursor: null } });
    }
    throw new Error(`Unhandled GET ${path}`);
  },
);

const postMock = mock((path: string, _init?: unknown) => {
  if (path === "/api/users/{userId}/password/reset") {
    return Promise.resolve({ data: { usernames: ["STU-100001"], default_password: "pass@1234" } });
  }
  throw new Error(`Unhandled POST ${path}`);
});

mock.module("../../../lib/api", () => ({ api: { GET: getMock, POST: postMock } }));

const loadPage = async (): Promise<ComponentType> => (await import("./SchoolMembersPage")).default;

async function renderPage() {
  const Page = await loadPage();
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
  postMock.mockClear();
});

describe("SchoolMembersPage", () => {
  test("shows how many students, teachers and parents with the school's ID range", async () => {
    await renderPage();
    const summary = await screen.findByRole("group", { name: "Members by role" });
    const students = within(summary).getByRole("region", { name: "Students" });
    expect(await within(students).findByText("120")).toBeTruthy();
    expect(within(students).getByText("IDs STU-1xxxxx")).toBeTruthy();
    const teachers = within(summary).getByRole("region", { name: "Teachers" });
    expect(within(teachers).getByText("12")).toBeTruthy();
    expect(within(teachers).getByText("IDs TCH-1xxxxx")).toBeTruthy();
    const parents = within(summary).getByRole("region", { name: "Parents" });
    expect(within(parents).getByText("95")).toBeTruthy();
    expect(within(parents).getByText("IDs PAR-1xxxxx")).toBeTruthy();
    const officers = within(summary).getByRole("region", { name: "Attendance officers" });
    expect(within(officers).getByText("3")).toBeTruthy();
    expect(within(officers).getByText("IDs ATT-1xxxxx")).toBeTruthy();
    expect(screen.getByText(/The starting password is pass@1234/)).toBeTruthy();
  });

  test("resets a member's password after confirmation", async () => {
    await renderPage();
    const table = await screen.findByRole("table", { name: "Students" });
    fireEvent.click(await within(table).findByRole("button", { name: "Reset password" }));
    const dialog = await screen.findByRole("dialog");
    expect(postMock).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Reset password" }));
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith("/api/users/{userId}/password/reset", {
        params: { path: { userId: "11111111-1111-4111-8111-111111111111" } },
      }),
    );
  });

  test("lists students with their IDs, and switches to teachers", async () => {
    await renderPage();
    const table = await screen.findByRole("table", { name: "Students" });
    expect(await within(table).findByText("STU-100001")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Show teachers" }));
    await waitFor(() =>
      expect(
        getMock.mock.calls.some(
          ([path, init]) => path === "/api/users" && init?.params.query.role === "INSTRUCTOR",
        ),
      ).toBe(true),
    );
    const teachers = await screen.findByRole("table", { name: "Teachers" });
    expect(await within(teachers).findByText("TCH-100001")).toBeTruthy();
  });
});
