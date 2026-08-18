import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, mock, test } from "bun:test";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { expectNoA11yViolations } from "../../../lib/test/axe";

import type { ComponentType } from "react";

/**
 * Automated accessibility audit for the discipline management screens (ST-197), mirroring
 * `approvals/a11y.test.tsx` — one render per representative state inside a `<main>`, matching how
 * `RootLayout` wraps every route.
 */

const INCIDENT = {
  id: "incident-1",
  school_id: "school-1",
  student_id: "student-1",
  class_id: null,
  reporter_user_id: "teacher-1",
  incident_type: "behavioral",
  severity: "major",
  status: "reported",
  title: "Cafeteria altercation",
  description: "Shoving match during lunch.",
  incident_at: "2026-08-16T10:00:00.000Z",
  resolved_at: null,
  created_at: "2026-08-16T10:00:00.000Z",
  updated_at: "2026-08-16T10:00:00.000Z",
};

const ACTION = {
  id: "action-1",
  school_id: "school-1",
  incident_id: "incident-1",
  action_type: "detention",
  action_by_user_id: "admin-1",
  status: "active",
  description: "One week detention.",
  effective_from: null,
  effective_until: null,
  created_at: "2026-08-16T11:00:00.000Z",
  updated_at: "2026-08-16T11:00:00.000Z",
};

const getMock = mock((path: string) => {
  if (path === "/api/discipline/incidents/{incidentId}") {
    return Promise.resolve<unknown>({ data: INCIDENT });
  }
  if (path === "/api/discipline/incidents/{incidentId}/actions") {
    return Promise.resolve<unknown>({ data: { actions: [ACTION], total: 1 } });
  }
  if (path === "/api/schools/current/settings") {
    return Promise.resolve<unknown>({ data: { parent_discipline_visibility: false } });
  }
  return Promise.resolve<unknown>({ data: { incidents: [], total: 0 } });
});

mock.module("../../../lib/api", () => ({ api: { GET: getMock } }));

const loadIncidentListPage = async (): Promise<ComponentType> =>
  (await import("./IncidentListPage")).default;
const loadIncidentDetailPage = async (): Promise<ComponentType> =>
  (await import("./IncidentDetailPage")).default;

function renderListInMain(Page: ComponentType) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <main>
          <Page />
        </main>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderDetailInMain(Page: ComponentType) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/portal/principal/discipline/incident-1"]}>
          <main>
            <Routes>
              <Route path="/portal/principal/discipline/:incidentId" element={<Page />} />
            </Routes>
          </main>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
});

describe("discipline management accessibility", () => {
  test("incident list, inbox tab", async () => {
    const { container } = renderListInMain(await loadIncidentListPage());
    await screen.findByRole("heading", { name: "Discipline incidents" });

    await expectNoA11yViolations(container);
  });

  test("incident detail", async () => {
    const { container } = renderDetailInMain(await loadIncidentDetailPage());
    await screen.findByRole("heading", { name: "Cafeteria altercation" });

    await expectNoA11yViolations(container);
  });

  test("add-action modal open", async () => {
    const { container } = renderDetailInMain(await loadIncidentDetailPage());
    await screen.findByRole("heading", { name: "Cafeteria altercation" });

    fireEvent.click(screen.getByRole("button", { name: "Add action" }));
    await screen.findByRole("dialog", { name: "Record a disciplinary action" });

    await expectNoA11yViolations(container);
  });

  test("resolve modal open", async () => {
    const { container } = renderDetailInMain(await loadIncidentDetailPage());
    await screen.findByRole("heading", { name: "Cafeteria altercation" });

    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
    await screen.findByRole("dialog", { name: "Resolve incident" });

    await expectNoA11yViolations(container);
  });
});
