import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import type { ComponentType } from "react";

/**
 * The platform console's school page: lifecycle actions come from the server's allowed
 * transitions, a status change needs a reason (and archiving needs the school's name typed back),
 * feature-flag overrides go out as true/false/null, students/teachers/parents are counted with their
 * member-code prefix, and the members table shows member codes and filters by role.
 */

const SCHOOL_ID = "11111111-1111-4111-8111-111111111111";

function school(status: "active" | "suspended") {
  return {
    id: SCHOOL_ID,
    slug: "alpha-academy",
    name: "Alpha Academy",
    email: "office@alpha.test",
    status,
    schoolNumber: 3,
    countryCode: "AE",
    currencyCode: "AED",
    isReviewTenant: false,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    emailVerifiedAt: null,
    activeUsers: 3,
    students: 2,
    subscription: null,
    roleCounts: { STUDENT: 2, ORG_ADMIN: 1 },
    featureFlags: [
      {
        name: "ai.llm",
        description: "LLM kill switch",
        defaultValue: false,
        override: null as boolean | null,
      },
    ],
    allowedTransitions: status === "active" ? ["suspended", "archived"] : ["active", "archived"],
  };
}

let current = school("active");

const STUDENT_ID = "22222222-2222-4222-8222-222222222222";
const PARENT_ID = "33333333-3333-4333-8333-333333333333";

const members = [
  {
    userId: STUDENT_ID,
    displayName: "Sara Ali",
    email: "sara@alpha.test",
    status: "active",
    roles: ["STUDENT"],
    memberCodes: ["STU-300001"],
    createdAt: "2026-08-01T00:00:00.000Z",
    lastLoginAt: null,
    student: {
      studentId: "44444444-4444-4444-8444-444444444444",
      admissionNumber: "ADM-7",
      status: "enrolled",
      classes: ["G5-A"],
      guardians: [{ userId: PARENT_ID, displayName: "Huda Ali", relationship: "mother" }],
    },
    teacher: null,
    children: [],
  },
  {
    userId: PARENT_ID,
    displayName: "Huda Ali",
    email: "huda@alpha.test",
    status: "invited",
    roles: ["PARENT"],
    memberCodes: ["PAR-300001"],
    createdAt: "2026-08-01T00:00:00.000Z",
    lastLoginAt: null,
    student: null,
    teacher: null,
    children: [
      {
        studentId: "44444444-4444-4444-8444-444444444444",
        userId: STUDENT_ID,
        name: "Sara Ali",
        admissionNumber: "ADM-7",
        relationship: "mother",
      },
    ],
  },
];

const getMock = mock(
  (path: string, init?: { params: { query?: { role?: string; search?: string } } }) => {
    if (path === "/api/platform/schools/{schoolId}") return Promise.resolve({ data: current });
    if (path === "/api/platform/schools/{schoolId}/members") {
      const role = init?.params.query?.role;
      const rows = role ? members.filter((member) => member.roles.includes(role)) : members;
      return Promise.resolve({
        data: {
          members: rows,
          total: rows.length,
          memberCount: 2,
          roleCounts: { STUDENT: 1, PARENT: 1 },
        },
      });
    }
    throw new Error(`Unhandled GET ${path}`);
  },
);
const patchMock = mock(
  (path: string, init: { body: { status: "active" | "suspended"; reason: string } }) => {
    if (path !== "/api/platform/schools/{schoolId}/status") throw new Error(`Unhandled ${path}`);
    current = school(init.body.status);
    return Promise.resolve({
      data: { school: current, aiSubscriptionsAffected: 4, aiBillingSynced: true },
    });
  },
);
const putMock = mock((_path: string, init: { body: { enabled: boolean | null } }) => {
  current = {
    ...current,
    featureFlags: [{ ...current.featureFlags[0]!, override: init.body.enabled }],
  };
  return Promise.resolve({ data: current });
});

mock.module("../../lib/api", () => ({ api: { GET: getMock, PATCH: patchMock, PUT: putMock } }));

const loadPage = async (): Promise<ComponentType> => (await import("./SchoolDetailPage")).default;

async function renderPage() {
  const Page = await loadPage();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={[`/portal/platform/schools/${SCHOOL_ID}`]}>
          <Routes>
            <Route path="/portal/platform/schools/:schoolId" element={<Page />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  current = school("active");
  getMock.mockClear();
  patchMock.mockClear();
  putMock.mockClear();
});

describe("SchoolDetailPage", () => {
  test("offers exactly the transitions the server allows", async () => {
    await renderPage();
    await screen.findByRole("heading", { name: "Alpha Academy", level: 1 });

    expect(screen.getByRole("button", { name: "Suspend school" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Archive school" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Activate school" })).toBeNull();
  });

  test("suspending requires a reason and sends it", async () => {
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Suspend school" }));

    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Confirm" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(within(dialog).getByLabelText(/Reason/), {
      target: { value: "Unpaid invoices" },
    });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirm);

    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));
    expect(patchMock.mock.calls[0]![1].body).toEqual({
      status: "suspended",
      reason: "Unpaid invoices",
    });
    // The page now reflects the server's answer: a suspended school can be reactivated.
    expect(await screen.findByRole("button", { name: "Activate school" })).toBeTruthy();
  });

  test("archiving also requires the school's name typed back", async () => {
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Archive school" }));

    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
    fireEvent.change(within(dialog).getByLabelText(/Reason/), {
      target: { value: "School closed" },
    });
    expect(confirm.disabled).toBe(true);

    fireEvent.change(within(dialog).getByLabelText(/Type the school's name/), {
      target: { value: "Alpha Academy" },
    });
    expect(confirm.disabled).toBe(false);
  });

  test("counts students, teachers and parents with the school's member-code prefix", async () => {
    await renderPage();
    const people = await screen.findByRole("region", { name: "People" });
    expect(within(people).getByText("IDs STU-3xxxxx")).toBeTruthy();
    expect(within(people).getByText("IDs TCH-3xxxxx")).toBeTruthy();
    expect(within(people).getByText("IDs PAR-3xxxxx")).toBeTruthy();
  });

  test("lists members with role counts and filters by role chip", async () => {
    await renderPage();
    const table = await screen.findByRole("table", { name: "Members of Alpha Academy" });
    await within(table).findByText("Sara Ali");
    expect(within(table).getByText("STU-300001")).toBeTruthy();
    expect(within(table).getByText("PAR-300001")).toBeTruthy();
    expect(within(table).getByText("Admission no. ADM-7")).toBeTruthy();
    expect(within(table).getByText("Children: Sara Ali (ADM-7)")).toBeTruthy();

    const chips = screen.getByRole("group", { name: "Filter members by role" });
    expect(within(chips).getByRole("button", { name: "All · 2" })).toBeTruthy();
    fireEvent.click(within(chips).getByRole("button", { name: "Parent · 1" }));

    await waitFor(() =>
      expect(
        getMock.mock.calls.some(
          ([path, init]) =>
            path === "/api/platform/schools/{schoolId}/members" &&
            init?.params.query?.role === "PARENT",
        ),
      ).toBe(true),
    );
    await waitFor(() => expect(within(table).queryByText("sara@alpha.test")).toBeNull());
    expect(within(table).getByText("huda@alpha.test")).toBeTruthy();
  });
});
