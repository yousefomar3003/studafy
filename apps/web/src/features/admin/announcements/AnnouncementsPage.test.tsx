import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import { AuthProvider, createSessionStore } from "../../../lib/auth";

import type { SessionTokens } from "../../../lib/auth";
import type { ComponentType } from "react";

const NOW = "2026-08-17T09:00:00.000Z";

const PUBLISHED_ANNOUNCEMENT = {
  id: "ann-1",
  school_id: "school-1",
  created_by: "admin-1",
  created_by_name: "Ada Lovelace",
  title: "Campus closed Friday",
  body: "The campus will be closed for maintenance.",
  mandatory: true,
  audience_type: "role",
  audience_role: "INSTRUCTOR",
  audience_class_id: null,
  audience_class_code: null,
  status: "published",
  scheduled_at: NOW,
  published_at: NOW,
  recipient_count: 5,
  notified_count: 5,
  created_at: NOW,
  updated_at: NOW,
};

function historyResponse(items: Record<string, unknown>[]) {
  return { items, next_cursor: null };
}

function defaultGetImplementation(path: string) {
  if (path === "/api/announcements") {
    return Promise.resolve<unknown>({ data: historyResponse([]) });
  }
  if (path === "/api/academics/classes") {
    return Promise.resolve<unknown>({
      data: { classes: [{ id: "class-1", code: "CLASS-MATH-101" }], total: 1 },
    });
  }
  return Promise.resolve<unknown>({ data: {} });
}

const getMock = mock(defaultGetImplementation);
const postMock = mock((_path: string, _init?: unknown) =>
  Promise.resolve<unknown>({ data: PUBLISHED_ANNOUNCEMENT }),
);

mock.module("../../../lib/api", () => ({
  api: { GET: getMock, POST: postMock, PATCH: postMock, DELETE: postMock },
}));

const loadAnnouncementsPage = async (): Promise<ComponentType> =>
  (await import("./AnnouncementsPage")).default;

/** Builds a JWT-shaped string (header.payload.signature), unsigned — matches
 * `audit/AuditLogExplorerPage.test.tsx`. */
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
            <Page />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>
    </AuthProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
  getMock.mockImplementation(defaultGetImplementation);
  postMock.mockClear();
});

describe("AnnouncementsPage", () => {
  test("shows a validation error and sends no request when required fields are empty", async () => {
    await renderAsOrgAdmin(await loadAnnouncementsPage());

    fireEvent.click(screen.getByRole("button", { name: "Publish now" }));

    expect(await screen.findByText("Title is required")).toBeTruthy();
    expect(postMock).not.toHaveBeenCalled();
  });

  test("choosing the 'role' audience reveals the role picker, and submits it in the request", async () => {
    await renderAsOrgAdmin(await loadAnnouncementsPage());

    fireEvent.change(screen.getByLabelText("Title", { exact: false }), {
      target: { value: "Staff meeting moved" },
    });
    fireEvent.change(screen.getByLabelText("Message", { exact: false }), {
      target: { value: "Meeting moved to Friday." },
    });
    fireEvent.click(screen.getByRole("radio", { name: "Everyone with a role" }));

    const roleSelect = screen.getByRole("combobox", { name: "Role" });
    fireEvent.click(roleSelect);
    fireEvent.click(screen.getByRole("option", { name: "Instructor" }));

    fireEvent.click(screen.getByRole("button", { name: "Publish now" }));

    await waitFor(() => {
      expect(postMock).toHaveBeenCalledTimes(1);
    });
    const [path, init] = postMock.mock.calls[0]! as [string, { body: Record<string, unknown> }];
    expect(path).toBe("/api/announcements");
    expect(init.body).toMatchObject({
      title: "Staff meeting moved",
      body: "Meeting moved to Friday.",
      mandatory: false,
      audience_type: "role",
      audience_role: "INSTRUCTOR",
    });
    expect(init.body.scheduled_at).toBeUndefined();
  });

  test("choosing the 'class' audience fetches and shows classes, and requires one to be picked", async () => {
    await renderAsOrgAdmin(await loadAnnouncementsPage());

    fireEvent.change(screen.getByLabelText("Title", { exact: false }), {
      target: { value: "Field trip" },
    });
    fireEvent.change(screen.getByLabelText("Message", { exact: false }), {
      target: { value: "Permission slips due Monday." },
    });
    fireEvent.click(screen.getByRole("radio", { name: "Everyone in a class" }));

    const classSelect = await screen.findByRole("combobox", { name: "Class" });
    fireEvent.click(classSelect);
    expect(await screen.findByRole("option", { name: "CLASS-MATH-101" })).toBeTruthy();
  });

  test("publishing switches to the History tab and shows the new announcement's reach", async () => {
    await renderAsOrgAdmin(await loadAnnouncementsPage());

    fireEvent.change(screen.getByLabelText("Title", { exact: false }), {
      target: { value: "Campus closed Friday" },
    });
    fireEvent.change(screen.getByLabelText("Message", { exact: false }), {
      target: { value: "The campus will be closed for maintenance." },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /Mandatory/ }));

    getMock.mockImplementation((path: string) => {
      if (path === "/api/announcements") {
        return Promise.resolve<unknown>({ data: historyResponse([PUBLISHED_ANNOUNCEMENT]) });
      }
      return defaultGetImplementation(path);
    });

    fireEvent.click(screen.getByRole("button", { name: "Publish now" }));

    expect(await screen.findByText("Announcement published")).toBeTruthy();

    const grid = within(await screen.findByRole("region", { name: "Announcement history" }));
    expect(await grid.findByText("Campus closed Friday")).toBeTruthy();
    expect(grid.getByText("Mandatory")).toBeTruthy();
    expect(grid.getByText("5 / 5")).toBeTruthy();
  });
});
