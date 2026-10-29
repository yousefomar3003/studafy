import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { AuthProvider, createSessionStore } from "../../../lib/auth";

import type { SessionTokens } from "../../../lib/auth";
import type { ComponentType } from "react";

const STUDENT: Record<string, unknown> = {
  id: "student-1",
  school_id: "school-1",
  user_id: "user-1",
  first_name: "Amara",
  middle_name: null,
  last_name: "Chen",
  preferred_name: null,
  date_of_birth: null,
  nationality_country_id: null,
  // What a principal receives: admission data is masked server-side (no billing:read).
  admission_number: "",
  admission_date: null,
  status: "enrolled",
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z",
};

const PARENT: Record<string, unknown> = {
  id: "parent-1",
  school_id: "school-1",
  email: "morgan@example.edu",
  display_name: "Morgan Lee",
  status: "active",
  roles: ["PARENT"],
  email_verified_at: null,
  last_login_at: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

function recordsFor(kind: "student" | "parent", value: string | null) {
  return {
    subject_kind: kind,
    subject_id: kind === "student" ? "student-1" : "parent-1",
    template_version: 1,
    missing_required: value === null ? 1 : 0,
    entries: [
      {
        field: {
          id: kind === "student" ? "field-allergies" : "field-employer",
          field_type: "short_text",
          label_en: kind === "student" ? "Allergies" : "Employer",
          label_ar: kind === "student" ? "الحساسية" : "جهة العمل",
          help_en: null,
          help_ar: null,
          required: true,
          options: [],
          sort_order: 0,
          visibility: "teachers",
          sensitivity: "standard",
          has_expiry: false,
        },
        archived: false,
        value,
        masked: false,
        mask: null,
        answered: value !== null,
        missing: value === null,
        answered_in_version: value === null ? null : 1,
        answered_field: null,
        document: null,
        updated_at: null,
      },
    ],
  };
}

let studentRecords = recordsFor("student", null);

interface RequestInit {
  params?: { path?: Record<string, string> };
  body?: { answers?: { field_id: string; value: string }[] };
}

const getMock = mock((path: string, _init?: RequestInit) => {
  if (path === "/api/students") {
    return Promise.resolve<unknown>({ data: { students: [STUDENT], next_cursor: null } });
  }
  if (path === "/api/students/{studentId}") return Promise.resolve<unknown>({ data: STUDENT });
  if (path === "/api/students/{studentId}/guardians") {
    return Promise.resolve<unknown>({
      data: [{ parent_user_id: "parent-1", relationship: "mother", family_id: "family-1" }],
    });
  }
  if (path === "/api/users/{userId}") return Promise.resolve<unknown>({ data: PARENT });
  if (path === "/api/students/{studentId}/records") {
    return Promise.resolve<unknown>({ data: studentRecords });
  }
  if (path === "/api/parents/{parentUserId}/records") {
    return Promise.resolve<unknown>({ data: recordsFor("parent", "Al Noor Clinic") });
  }
  return Promise.resolve<unknown>({ data: {} });
});

const putMock = mock((path: string, init?: RequestInit) => {
  if (path === "/api/students/{studentId}/records") {
    studentRecords = recordsFor("student", init?.body?.answers?.[0]?.value ?? null);
    return Promise.resolve<unknown>({ data: studentRecords });
  }
  return Promise.resolve<unknown>({ data: {} });
});

mock.module("../../../lib/api", () => ({
  api: { GET: getMock, PUT: putMock, POST: mock(), PATCH: mock(), DELETE: mock() },
}));

function fakeJwt(payload: unknown): string {
  const segment = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${segment({ alg: "RS256" })}.${segment(payload)}.signature`;
}

async function renderAsPrincipal(url: string) {
  const [StudentsPage, StudentPage, ParentPage] = (await Promise.all([
    import("./PrincipalStudentsPage"),
    import("./PrincipalStudentPage"),
    import("./PrincipalParentPage"),
  ]).then((modules) => modules.map((module) => module.default))) as ComponentType[];
  const store = createSessionStore({
    refreshClient: {
      refresh: async (): Promise<SessionTokens> => ({
        accessToken: fakeJwt({ roles: ["PRINCIPAL"] }),
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
          <MemoryRouter initialEntries={[url]}>
            <Routes>
              <Route path="/portal/principal/students" element={<StudentsPage />} />
              <Route path="/portal/principal/students/:studentId" element={<StudentPage />} />
              <Route path="/portal/principal/parents/:parentUserId" element={<ParentPage />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>
    </AuthProvider>,
  );
}

afterEach(() => {
  cleanup();
  studentRecords = recordsFor("student", null);
  getMock.mockClear();
  putMock.mockClear();
});

describe("Principal > Students", () => {
  test("a principal opens a student from the roll and fills in their record", async () => {
    await renderAsPrincipal("/portal/principal/students");

    fireEvent.click(await screen.findByRole("link", { name: "Amara Chen" }));
    expect(await screen.findByRole("heading", { name: "Amara Chen" })).toBeTruthy();
    // Read-only on everything else: no admission data on the page.
    expect(screen.queryByText(/Admission/)).toBeNull();

    const records = await screen.findByRole("region", { name: "Records" });
    expect(within(records).getByText("1 required field is missing")).toBeTruthy();
    fireEvent.click(within(records).getByRole("button", { name: "Edit record" }));
    fireEvent.change(within(records).getByLabelText(/Allergies/), { target: { value: "Peanuts" } });
    fireEvent.click(within(records).getByRole("button", { name: "Save record" }));

    await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
    const [path, init] = putMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/students/{studentId}/records");
    expect(init.params?.path).toEqual({ studentId: "student-1" });
    expect(init.body).toEqual({ answers: [{ field_id: "field-allergies", value: "Peanuts" }] });
    expect(await within(records).findByText("Peanuts")).toBeTruthy();
  });

  test("each guardian opens that parent's record", async () => {
    await renderAsPrincipal("/portal/principal/students/student-1");

    fireEvent.click(await screen.findByRole("link", { name: "Open Morgan Lee's records" }));
    expect(await screen.findByRole("heading", { name: "Morgan Lee: records" })).toBeTruthy();
    expect(await screen.findByText("Al Noor Clinic")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back" }).getAttribute("href")).toBe(
      "/portal/principal/students/student-1",
    );
  });
});
