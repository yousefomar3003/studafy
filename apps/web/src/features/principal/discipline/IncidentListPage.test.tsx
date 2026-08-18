import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

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
mock.module("../../../lib/api", () => ({ api: { GET: getMock } }));

const loadIncidentListPage = async (): Promise<ComponentType> =>
  (await import("./IncidentListPage")).default;

function renderPage(Page: ComponentType) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Page />
      </MemoryRouter>
    </QueryClientProvider>,
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

    renderPage(await loadIncidentListPage());

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

    renderPage(await loadIncidentListPage());

    fireEvent.click(screen.getByRole("tab", { name: "All incidents" }));

    expect(await screen.findByText("Repeated tardiness")).toBeTruthy();
  });

  test("renders the empty state when nothing matches", async () => {
    getMock.mockImplementation(() => Promise.resolve({ data: { incidents: [], total: 0 } }));

    renderPage(await loadIncidentListPage());

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

    renderPage(await loadIncidentListPage());

    const link = await screen.findByRole("link", { name: "Cafeteria altercation" });
    expect(link.getAttribute("href")).toBe("/portal/principal/discipline/incident-1");
  });
});
