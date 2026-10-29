import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import { AuthProvider } from "../../../lib/auth";
import { createTestSessionStore } from "../../../lib/test/session";

import type { ComponentType } from "react";

const STUDENT = {
  student_id: "student-1",
  name: "Amara Chen",
  admission_number: "ADM-001",
  missing: [
    { field_id: "f-1", label_en: "Birth certificate", label_ar: "شهادة الميلاد", expires_on: null },
  ],
  expired: [
    {
      field_id: "f-2",
      label_en: "Vaccination record",
      label_ar: "سجل التطعيم",
      expires_on: "2026-01-15",
    },
  ],
  expiring: [],
};

const PARENT = {
  user_id: "parent-1",
  name: "Morgan Lee",
  email: "morgan@example.edu",
  missing: [{ field_id: "f-3", label_en: "Work phone", label_ar: "هاتف العمل", expires_on: null }],
  expired: [],
  expiring: [],
};

interface RequestInit {
  params?: { query?: Record<string, unknown> };
}

const getMock = mock((path: string, _init?: RequestInit) => {
  if (path === "/api/records/missing/students") {
    return Promise.resolve<unknown>({ data: { students: [STUDENT], total: 1, issue: null } });
  }
  if (path === "/api/records/missing/parents") {
    return Promise.resolve<unknown>({ data: { parents: [PARENT], total: 1, issue: null } });
  }
  if (path === "/api/records/missing/summary") {
    return Promise.resolve<unknown>({
      data: { students: 3, parents: 1, expired_documents: 2, expiring_documents: 1 },
    });
  }
  return Promise.resolve<unknown>({ data: undefined });
});

mock.module("../../../lib/api", () => ({ api: { GET: getMock } }));

const loadPage = async () =>
  (await import("./MissingInformationPage")).default as ComponentType<{
    portal?: "admin" | "principal";
  }>;

function wrap(node: React.ReactNode, store: Awaited<ReturnType<typeof createTestSessionStore>>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <AuthProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <MemoryRouter>{node}</MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>
    </AuthProvider>,
  );
}

async function renderPage(roles: string[], portal: "admin" | "principal") {
  const Page = await loadPage();
  return wrap(<Page portal={portal} />, await createTestSessionStore(roles));
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
});

describe("MissingInformationPage", () => {
  test("lists students with their missing and expired fields, linking to the admin Records tab", async () => {
    await renderPage(["ORG_ADMIN"], "admin");

    // The section and the grid inside it are both named for the list; the section is the outer one.
    const [students] = await screen.findAllByRole("region", {
      name: /Students with missing information/,
    });
    if (!students) throw new Error("students region missing");
    expect(await within(students).findByText("Amara Chen")).toBeTruthy();
    expect(within(students).getByText(/Birth certificate/)).toBeTruthy();
    expect(within(students).getByText(/Vaccination record \(/)).toBeTruthy();
    const link = within(students).getByRole("link", { name: "Open Amara Chen's record" });
    expect(link.getAttribute("href")).toBe("/portal/admin/students/student-1?tab=records");
  });

  test("parents are on their own tab, linking to the admin parent records view", async () => {
    await renderPage(["ORG_ADMIN"], "admin");
    fireEvent.click(await screen.findByRole("tab", { name: "Parents" }));
    const link = await screen.findByRole("link", { name: "Open Morgan Lee's record" });
    expect(link.getAttribute("href")).toBe("/portal/admin/parents/parent-1/records");
  });

  test("the principal portal links to the principal's student and parent pages", async () => {
    await renderPage(["PRINCIPAL"], "principal");
    const student = await screen.findByRole("link", { name: "Open Amara Chen's record" });
    expect(student.getAttribute("href")).toBe("/portal/principal/students/student-1");
    fireEvent.click(screen.getByRole("tab", { name: "Parents" }));
    const parent = await screen.findByRole("link", { name: "Open Morgan Lee's record" });
    expect(parent.getAttribute("href")).toBe("/portal/principal/parents/parent-1");
  });

  test("search and the issue filter are sent to the API", async () => {
    await renderPage(["PRINCIPAL"], "principal");
    await screen.findByText("Amara Chen");

    const search = screen.getByRole("searchbox", { name: "Search students" });
    fireEvent.change(search, { target: { value: "amara" } });
    fireEvent.submit(search.closest("form")!);
    await waitFor(() =>
      expect(getMock).toHaveBeenCalledWith("/api/records/missing/students", {
        params: { query: { search: "amara", issue: undefined, limit: 20, offset: 0 } },
      }),
    );

    fireEvent.click(screen.getByRole("combobox", { name: "Show" }));
    fireEvent.click(await screen.findByRole("option", { name: "Expired" }));
    await waitFor(() =>
      expect(getMock).toHaveBeenCalledWith("/api/records/missing/students", {
        params: { query: { search: "amara", issue: "expired", limit: 20, offset: 0 } },
      }),
    );
  });
});

describe("missing information on the dashboards", () => {
  test("the admin dashboard counts people with missing information, with the permission", async () => {
    const Page = (await import("../../admin/AdminDashboardPage")).default;
    wrap(<Page />, await createTestSessionStore(["ORG_ADMIN"]));
    const link = await screen.findByRole("link", { name: /Missing information/ });
    expect(link.getAttribute("href")).toBe("/portal/admin/records/missing");
    await waitFor(() => expect(within(link).getByText("4")).toBeTruthy());
  });

  test("without studentRecord:read the admin dashboard neither shows nor fetches it", async () => {
    const Page = (await import("../../admin/AdminDashboardPage")).default;
    wrap(<Page />, await createTestSessionStore(["ATTENDANCE_OFFICER"]));
    await screen.findAllByRole("heading");
    expect(screen.queryByText("Missing information")).toBeNull();
    expect(getMock.mock.calls.some(([path]) => path === "/api/records/missing/summary")).toBe(
      false,
    );
  });

  test("the principal dashboard shows the tile and the links, with the permission", async () => {
    const Page = (await import("../../principal/PrincipalDashboardPage")).default;
    wrap(<Page />, await createTestSessionStore(["PRINCIPAL"]));
    const tile = await screen.findByRole("region", { name: "Missing information" });
    expect(await within(tile).findByText("3 students with missing information")).toBeTruthy();
    expect(within(tile).getByText("2 documents expired")).toBeTruthy();
    expect(
      within(tile).getByRole("link", { name: "See missing information" }).getAttribute("href"),
    ).toBe("/portal/principal/records/missing");
    expect(
      screen.getByRole("link", { name: "Student and parent records" }).getAttribute("href"),
    ).toBe("/portal/principal/school/records");
  });

  test("without studentRecord:read the principal dashboard has no tile", async () => {
    const Page = (await import("../../principal/PrincipalDashboardPage")).default;
    wrap(<Page />, await createTestSessionStore(["ATTENDANCE_OFFICER"]));
    await screen.findAllByRole("heading");
    expect(screen.queryByRole("region", { name: "Missing information" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Student and parent records" })).toBeNull();
  });
});
