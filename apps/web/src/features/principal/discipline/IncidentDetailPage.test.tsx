import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import type { ComponentType } from "react";

interface RequestInit {
  params?: { path?: Record<string, string>; query?: Record<string, unknown> };
  body?: Record<string, unknown>;
}

let incident: Record<string, unknown> = {
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

let actions: Record<string, unknown>[] = [];
let parentVisibility = false;

const getMock = mock((path: string, _init?: RequestInit) => {
  if (path === "/api/discipline/incidents/{incidentId}") {
    return Promise.resolve<unknown>({ data: incident });
  }
  if (path === "/api/discipline/incidents/{incidentId}/actions") {
    return Promise.resolve<unknown>({ data: { actions, total: actions.length } });
  }
  if (path === "/api/schools/current/settings") {
    return Promise.resolve<unknown>({ data: { parent_discipline_visibility: parentVisibility } });
  }
  return Promise.resolve<unknown>({ data: undefined });
});

const postMock = mock((path: string, init?: RequestInit) => {
  if (path === "/api/discipline/incidents/{incidentId}/actions") {
    const action = {
      id: "action-1",
      school_id: "school-1",
      incident_id: "incident-1",
      action_type: init?.body?.action_type ?? "verbal_warning",
      action_by_user_id: "admin-1",
      status: "pending",
      description: init?.body?.description ?? null,
      effective_from: null,
      effective_until: null,
      created_at: "2026-08-16T11:00:00.000Z",
      updated_at: "2026-08-16T11:00:00.000Z",
    };
    actions = [...actions, action];
    return Promise.resolve<unknown>({ data: action });
  }
  if (path === "/api/discipline/incidents/{incidentId}/resolve") {
    incident = { ...incident, status: "resolved", resolved_at: "2026-08-16T12:00:00.000Z" };
    return Promise.resolve<unknown>({ data: incident });
  }
  return Promise.resolve<unknown>({ data: undefined });
});

const patchMock = mock((_path: string, init?: RequestInit) => {
  incident = { ...incident, status: init?.body?.status ?? incident.status };
  return Promise.resolve<unknown>({ data: incident });
});

mock.module("../../../lib/api", () => ({
  api: { GET: getMock, POST: postMock, PATCH: patchMock },
}));

const loadIncidentDetailPage = async (): Promise<ComponentType> =>
  (await import("./IncidentDetailPage")).default;

function renderPage(Page: ComponentType) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/portal/principal/discipline/incident-1"]}>
          <Routes>
            <Route path="/portal/principal/discipline/:incidentId" element={<Page />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
  postMock.mockClear();
  patchMock.mockClear();
  actions = [];
  parentVisibility = false;
  incident = {
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
});

describe("IncidentDetailPage", () => {
  test("renders incident details and the reported-status workflow buttons", async () => {
    renderPage(await loadIncidentDetailPage());

    expect(await screen.findByRole("heading", { name: "Cafeteria altercation" })).toBeTruthy();
    expect(screen.getByText("Behavioral")).toBeTruthy();
    expect(screen.getByText("Major")).toBeTruthy();
    expect(screen.getByText("Reported")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start review" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Escalate" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  });

  test("Resolve is disabled until an action is recorded, then enables once one exists", async () => {
    renderPage(await loadIncidentDetailPage());
    await screen.findByRole("heading", { name: "Cafeteria altercation" });

    const resolveButton = screen.getByRole("button", { name: "Resolve" }) as HTMLButtonElement;
    expect(resolveButton.disabled).toBe(true);
    expect(
      screen.getByText("Record at least one disciplinary action before resolving this incident."),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Add action" }));
    fireEvent.click(screen.getByRole("button", { name: "Record action" }));

    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith(
        "/api/discipline/incidents/{incidentId}/actions",
        expect.objectContaining({ params: { path: { incidentId: "incident-1" } } }),
      );
    });

    await waitFor(() => {
      const button = screen.getByRole("button", { name: "Resolve" }) as HTMLButtonElement;
      expect(button.disabled).toBe(false);
    });
  });

  test("resolving submits resolution notes and refreshes the incident status", async () => {
    actions = [
      {
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
      },
    ];

    renderPage(await loadIncidentDetailPage());
    await screen.findByRole("heading", { name: "Cafeteria altercation" });

    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
    const dialog = screen.getByRole("dialog", { name: "Resolve incident" });
    fireEvent.change(within(dialog).getByLabelText("Resolution notes"), {
      target: { value: "Parent met with principal; detention served." },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Resolve" }));

    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith(
        "/api/discipline/incidents/{incidentId}/resolve",
        expect.objectContaining({
          params: { path: { incidentId: "incident-1" } },
          body: { resolution_description: "Parent met with principal; detention served." },
        }),
      );
    });

    expect(await screen.findByText("Resolved")).toBeTruthy();
  });

  test("shows the school's parent-visibility policy for a resolved incident", async () => {
    incident = { ...incident, status: "resolved", resolved_at: "2026-08-15T09:00:00.000Z" };
    parentVisibility = true;

    renderPage(await loadIncidentDetailPage());

    expect(await screen.findByText("Visible to the student's parent")).toBeTruthy();
  });
});
