import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { AuthProvider } from "../../../lib/auth";
import { createTestSessionStore } from "../../../lib/test/session";

import type { ComponentType } from "react";

function incident(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "incident-1",
    school_id: "school-1",
    student_id: "student-1",
    class_id: null,
    reporter_user_id: "user-1",
    incident_type: "behavioral",
    severity: "major",
    status: "reported",
    title: "Cafeteria altercation",
    description: null,
    incident_at: "2026-08-16T10:00:00.000Z",
    resolved_at: null,
    created_at: "2026-08-16T10:00:00.000Z",
    updated_at: "2026-08-16T10:00:00.000Z",
    ...overrides,
  };
}

const getMock = mock((_path: string, _init?: { params?: { query?: unknown } }) =>
  Promise.resolve<unknown>({ data: { incidents: [], total: 0 } }),
);
const postMock = mock((_path: string, _init?: unknown) =>
  Promise.resolve<unknown>({ data: incident({ id: "incident-new" }) }),
);
mock.module("../../../lib/api", () => ({ api: { GET: getMock, POST: postMock } }));

const loadIncidentListPage = async (): Promise<ComponentType> =>
  (await import("./IncidentListPage")).default;

async function renderPage(Page: ComponentType, path = "/portal/principal/discipline") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const store = await createTestSessionStore(["PRINCIPAL"]);
  return render(
    <AuthProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path="/portal/principal/discipline" element={<Page />} />
              <Route
                path="/portal/principal/discipline/:incidentId"
                element={<p>Incident page</p>}
              />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>
    </AuthProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
});

describe("IncidentListPage", () => {
  test("the inbox tab defaults to open and shows only teacher-reported incidents", async () => {
    getMock.mockImplementation((_path: string, init?: { params?: { query?: unknown } }) => {
      const query = (init?.params?.query ?? {}) as { status?: string };
      if (query.status === "reported") {
        return Promise.resolve({ data: { incidents: [incident()], total: 1 } });
      }
      return Promise.resolve({ data: { incidents: [], total: 0 } });
    });

    await renderPage(await loadIncidentListPage());

    expect(
      screen.getByRole("tab", { name: "Teacher-reported inbox" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(await screen.findByText("Cafeteria altercation")).toBeTruthy();
  });

  test("switching to the all-incidents tab merges every open status by default", async () => {
    getMock.mockImplementation((_path: string, init?: { params?: { query?: unknown } }) => {
      const query = (init?.params?.query ?? {}) as { status?: string };
      if (query.status === "reported") {
        return Promise.resolve({ data: { incidents: [], total: 0 } });
      }
      if (query.status === "escalated") {
        return Promise.resolve({
          data: {
            incidents: [
              incident({
                id: "incident-2",
                title: "Repeated tardiness",
                severity: "moderate",
                status: "escalated",
              }),
            ],
            total: 1,
          },
        });
      }
      return Promise.resolve({ data: { incidents: [], total: 0 } });
    });

    await renderPage(await loadIncidentListPage());

    fireEvent.click(screen.getByRole("tab", { name: "All incidents" }));

    expect(await screen.findByText("Repeated tardiness")).toBeTruthy();
  });

  test("renders the empty state when nothing matches", async () => {
    getMock.mockImplementation(() => Promise.resolve({ data: { incidents: [], total: 0 } }));

    await renderPage(await loadIncidentListPage());

    expect(await screen.findByText("No incidents are waiting for triage.")).toBeTruthy();
  });

  test("a row's title links to the incident detail page", async () => {
    getMock.mockImplementation((_path: string, init?: { params?: { query?: unknown } }) => {
      const query = (init?.params?.query ?? {}) as { status?: string };
      if (query.status === "reported") {
        return Promise.resolve({ data: { incidents: [incident()], total: 1 } });
      }
      return Promise.resolve({ data: { incidents: [], total: 0 } });
    });

    await renderPage(await loadIncidentListPage());

    const link = await screen.findByRole("link", { name: "Cafeteria altercation" });
    expect(link.getAttribute("href")).toBe("/portal/principal/discipline/incident-1");
  });
  test("a principal reports an incident about a student they search for, then lands on it", async () => {
    getMock.mockImplementation((path: string) => {
      if (path === "/api/students") {
        return Promise.resolve({
          data: {
            students: [
              {
                id: "student-7",
                first_name: "Omar",
                last_name: "Saleh",
                preferred_name: null,
                admission_number: "ADM-007",
              },
            ],
            next_cursor: null,
          },
        });
      }
      return Promise.resolve({ data: { incidents: [], total: 0 } });
    });

    await renderPage(await loadIncidentListPage(), "/portal/principal/discipline?report=1");

    const dialog = await screen.findByRole("dialog", { name: "Report an incident" });
    const submit = within(dialog).getByRole("button", { name: "Report incident" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(within(dialog).getByRole("searchbox", { name: "Student" }), {
      target: { value: "Omar" },
    });
    fireEvent.click(await within(dialog).findByRole("button", { name: /Omar Saleh/ }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: /^Title/ }), {
      target: { value: "Fight at break" },
    });
    fireEvent.click(submit);

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    const body = (postMock.mock.calls[0]![1] as { body: Record<string, unknown> }).body;
    expect(body).toMatchObject({
      student_id: "student-7",
      incident_type: "behavioral",
      severity: "minor",
      title: "Fight at break",
    });
    expect(typeof body.incident_at).toBe("string");
    expect(await screen.findByText("Incident page")).toBeTruthy();
  });
});
