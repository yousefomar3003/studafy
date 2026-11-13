import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { PortalBackLink, PortalBackProvider } from "../../layouts/portal/PortalBackLink";
import { AuthProvider } from "../../lib/auth";
import { expectNoA11yViolations } from "../../lib/test/axe";
import { createTestSessionStore } from "../../lib/test/session";

import type { ComponentType, ReactNode } from "react";

/**
 * Staff and class records in the web app: the staff record page (ORG_ADMIN edits and reveals; a
 * principal only reads), the class record page (timetable:manage edits; a teacher only reads), and
 * the Staff and Classes tabs of Missing information, each shown only to whoever may read them.
 * Every view is audited with axe inside a `<main>`, as RootLayout renders routes.
 */

const SALARY = "4,250 JOD";

function field(overrides: Record<string, unknown>) {
  return {
    help_en: null,
    help_ar: null,
    required: false,
    options: [],
    sort_order: 0,
    visibility: "staff_only",
    sensitivity: "standard",
    has_expiry: false,
    ...overrides,
  };
}

function entry(definition: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    field: definition,
    archived: false,
    value: null,
    masked: false,
    mask: null,
    answered: false,
    missing: false,
    answered_in_version: null,
    answered_field: null,
    document: null,
    updated_at: null,
    ...overrides,
  };
}

const QUALIFICATION = field({
  id: "f-qual",
  field_type: "short_text",
  label_en: "Qualification",
  label_ar: "المؤهل",
});
const SALARY_FIELD = field({
  id: "f-salary",
  field_type: "short_text",
  label_en: "Monthly salary",
  label_ar: "الراتب الشهري",
  sensitivity: "sensitive",
});
const BUS_GROUP = field({
  id: "f-bus",
  field_type: "short_text",
  label_en: "Bus group",
  label_ar: "مجموعة الحافلة",
  visibility: "teachers",
});

const staffRecords = {
  subject_kind: "staff",
  subject_id: "user-1",
  template_version: 1,
  missing_required: 0,
  entries: [
    entry(QUALIFICATION, { value: "BEd Mathematics", answered: true }),
    entry(SALARY_FIELD, { masked: true, mask: "•••• JOD", answered: true }),
  ],
};

const classRecords = {
  subject_kind: "class",
  subject_id: "class-1",
  template_version: 1,
  missing_required: 0,
  entries: [entry(BUS_GROUP, { value: "Route 4", answered: true })],
};

interface RequestInit {
  params?: { path?: Record<string, string>; query?: Record<string, unknown> };
}

const getMock = mock((path: string, _init?: RequestInit) => {
  switch (path) {
    case "/api/users/{userId}":
      return Promise.resolve<unknown>({
        data: { id: "user-1", display_name: "Lina Saleh", email: "lina@example.edu" },
      });
    case "/api/staff/{staffUserId}/records":
      return Promise.resolve<unknown>({ data: staffRecords });
    case "/api/academics/classes/{classId}":
      return Promise.resolve<unknown>({ data: { id: "class-1", code: "CLS-10A" } });
    case "/api/classes/{classId}/records":
      return Promise.resolve<unknown>({ data: classRecords });
    case "/api/records/missing/students":
      return Promise.resolve<unknown>({ data: { students: [], total: 0, issue: "all" } });
    case "/api/records/missing/parents":
      return Promise.resolve<unknown>({ data: { parents: [], total: 0, issue: "all" } });
    case "/api/records/missing/staff":
      return Promise.resolve<unknown>({
        data: {
          staff: [
            {
              user_id: "user-1",
              name: "Lina Saleh",
              email: "lina@example.edu",
              missing: [
                {
                  field_id: "f-licence",
                  label_en: "Teaching licence",
                  label_ar: "رخصة التعليم",
                  expires_on: null,
                },
              ],
              expired: [],
              expiring: [],
            },
          ],
          total: 1,
          issue: "all",
        },
      });
    case "/api/records/missing/classes":
      return Promise.resolve<unknown>({
        data: {
          classes: [
            {
              class_id: "class-1",
              code: "CLS-10A",
              course_name: "Mathematics 10",
              missing: [
                {
                  field_id: "f-homeroom",
                  label_en: "Homeroom notes",
                  label_ar: "ملاحظات الصف",
                  expires_on: null,
                },
              ],
              expired: [],
              expiring: [],
            },
          ],
          total: 1,
          issue: "all",
        },
      });
    default:
      return Promise.resolve<unknown>({ data: undefined });
  }
});

const postMock = mock((path: string, _init?: RequestInit) => {
  if (path === "/api/staff/{staffUserId}/records/{fieldId}/reveal") {
    return Promise.resolve<unknown>({ data: { field_id: "f-salary", value: SALARY } });
  }
  return Promise.resolve<unknown>({ data: {} });
});

mock.module("../../lib/api", () => ({ api: { GET: getMock, POST: postMock } }));

async function renderAt(roles: string[], url: string, route: string, element: ReactNode) {
  const store = await createTestSessionStore(roles);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <AuthProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <MemoryRouter initialEntries={[url]}>
            <PortalBackProvider>
              <PortalBackLink routes={() => []} />
              <main>
                <Routes>
                  <Route path={route} element={element} />
                </Routes>
              </main>
            </PortalBackProvider>
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>
    </AuthProvider>,
  );
}

type PortalPage = ComponentType<{ portal?: "admin" | "principal" }>;

const loadStaffPage = async () => (await import("./StaffRecordPage")).default as PortalPage;
const loadClassPage = async () => (await import("./ClassRecordPage")).default as PortalPage;
const loadMissingPage = async () =>
  (await import("./missing/MissingInformationPage")).default as PortalPage;

afterEach(() => {
  cleanup();
  getMock.mockClear();
  postMock.mockClear();
});

describe("staff record page", () => {
  test("ORG_ADMIN sees the masked salary, reveals it through the staff route, and can edit", async () => {
    const Page = await loadStaffPage();
    const { container } = await renderAt(
      ["ORG_ADMIN"],
      "/portal/admin/staff/user-1/records",
      "/portal/admin/staff/:staffUserId/records",
      <Page portal="admin" />,
    );
    expect(await screen.findByRole("heading", { name: "Lina Saleh: staff record" })).toBeTruthy();
    expect(await screen.findByText("BEd Mathematics")).toBeTruthy();
    expect(screen.queryByText(SALARY)).toBeNull();
    expect(screen.getByRole("button", { name: "Edit record" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back" }).getAttribute("href")).toBe(
      "/portal/admin/teachers",
    );
    await expectNoA11yViolations(container);

    fireEvent.click(screen.getByRole("button", { name: "Reveal Monthly salary" }));
    expect(await screen.findByText(SALARY)).toBeTruthy();
    const [path, init] = postMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/staff/{staffUserId}/records/{fieldId}/reveal");
    expect(init.params?.path).toEqual({ staffUserId: "user-1", fieldId: "f-salary" });
  });

  test("a principal reads it with no Edit and no Reveal", async () => {
    const Page = await loadStaffPage();
    const { container } = await renderAt(
      ["PRINCIPAL"],
      "/portal/principal/staff/user-1/records",
      "/portal/principal/staff/:staffUserId/records",
      <Page portal="principal" />,
    );
    expect(await screen.findByText("BEd Mathematics")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit record" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Reveal/ })).toBeNull();
    expect(screen.getByRole("link", { name: "Back" }).getAttribute("href")).toBe(
      "/portal/principal/records/missing",
    );
    await expectNoA11yViolations(container);
  });
});

describe("class record page", () => {
  test("a principal (timetable:manage) can edit a class's record", async () => {
    const Page = await loadClassPage();
    const { container } = await renderAt(
      ["PRINCIPAL"],
      "/portal/principal/classes/class-1/records",
      "/portal/principal/classes/:classId/records",
      <Page portal="principal" />,
    );
    expect(await screen.findByRole("heading", { name: "CLS-10A: class record" })).toBeTruthy();
    expect(await screen.findByText("Route 4")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit record" })).toBeTruthy();
    expect(getMock.mock.calls.some(([path]) => path === "/api/classes/{classId}/records")).toBe(
      true,
    );
    await expectNoA11yViolations(container);
  });

  test("a teacher reads it and cannot edit", async () => {
    const Page = await loadClassPage();
    await renderAt(
      ["INSTRUCTOR"],
      "/portal/principal/classes/class-1/records",
      "/portal/principal/classes/:classId/records",
      <Page portal="principal" />,
    );
    expect(await screen.findByText("Route 4")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit record" })).toBeNull();
  });
});

describe("missing information: staff and classes", () => {
  test("ORG_ADMIN gets Staff and Classes tabs, each row linking to its record page", async () => {
    const Page = await loadMissingPage();
    const { container } = await renderAt(
      ["ORG_ADMIN"],
      "/portal/admin/records/missing",
      "/portal/admin/records/missing",
      <Page portal="admin" />,
    );
    fireEvent.click(await screen.findByRole("tab", { name: "Staff" }));
    const staffLink = await screen.findByRole("link", { name: "Open Lina Saleh's record" });
    expect(staffLink.getAttribute("href")).toBe("/portal/admin/staff/user-1/records");
    const [staffRegion] = screen.getAllByRole("region", {
      name: /Staff with missing information/,
    });
    expect(within(staffRegion!).getByText(/Teaching licence/)).toBeTruthy();
    await expectNoA11yViolations(container);

    fireEvent.click(screen.getByRole("tab", { name: "Classes" }));
    const classLink = await screen.findByRole("link", { name: "Open the record of class CLS-10A" });
    expect(classLink.getAttribute("href")).toBe("/portal/admin/classes/class-1/records");
    expect(screen.getByText("Mathematics 10")).toBeTruthy();
    await expectNoA11yViolations(container);
  });

  test("a teacher sees the Classes tab but never the Staff tab", async () => {
    const Page = await loadMissingPage();
    await renderAt(
      ["INSTRUCTOR"],
      "/portal/principal/records/missing",
      "/portal/principal/records/missing",
      <Page portal="principal" />,
    );
    expect(await screen.findByRole("tab", { name: "Classes" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Staff" })).toBeNull();
    await waitFor(() =>
      expect(getMock.mock.calls.some(([path]) => path === "/api/records/missing/staff")).toBe(
        false,
      ),
    );
  });
});
