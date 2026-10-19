import { PERMISSIONS } from "@studafy/constants";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { AuthProvider, createSessionStore, RequirePermission } from "../../../lib/auth";

import { reportFixture } from "./test-fixtures";

import type { SessionTokens } from "../../../lib/auth";
import type { ComponentType } from "react";

interface RequestInit {
  params?: { query?: Record<string, unknown> };
}

const getMock = mock((_path: string, _init?: RequestInit) =>
  Promise.resolve<unknown>({
    data: {
      reports: [
        reportFixture(),
        reportFixture({
          id: "report-2",
          status: "in_review",
          priority: "normal",
          is_overdue: false,
          reason_category: "spam",
          reporter: { id: "teacher-2", name: "Nadia Karim", role: "teacher" },
          reported: { id: "parent-2", name: "Faris Aziz", role: "parent" },
          student: { id: "student-2", name: "Lina Aziz" },
        }),
      ],
      total: 2,
      limit: 25,
      offset: 0,
    },
  }),
);

mock.module("../../../lib/api", () => ({ api: { GET: getMock } }));

const loadListPage = async (): Promise<ComponentType> =>
  (await import("./MessageReportListPage")).default;

function fakeJwt(payload: unknown): string {
  const segment = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${segment({ alg: "RS256" })}.${segment(payload)}.signature`;
}

async function renderAs(role: string) {
  const Page = await loadListPage();
  const store = createSessionStore({
    refreshClient: {
      refresh: async (): Promise<SessionTokens> => ({
        accessToken: fakeJwt({ roles: [role] }),
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
        <MemoryRouter initialEntries={["/portal/principal/message-reports"]}>
          <Routes>
            <Route
              path="/portal/principal/message-reports"
              element={
                <RequirePermission permission={PERMISSIONS.MESSAGE_REPORT_REVIEW}>
                  <Page />
                </RequirePermission>
              }
            />
            <Route path="/portal" element={<p>Portal home</p>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </AuthProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
});

describe("MessageReportListPage", () => {
  test("lists open reports with priority, overdue flag, parties and a review link", async () => {
    await renderAs("PRINCIPAL");

    expect(await screen.findByRole("heading", { name: "Message reports" })).toBeTruthy();
    expect(await screen.findByText("Harassment")).toBeTruthy();
    expect(getMock).toHaveBeenCalledWith(
      "/api/messaging/reports",
      expect.objectContaining({ params: { query: { limit: 25, offset: 0, status: "open" } } }),
    );

    const rows = screen.getAllByRole("row");
    const first = rows.find((row) => within(row).queryByText("Harassment"));
    if (!first) throw new Error("Harassment row missing");
    expect(within(first).getByText("Urgent")).toBeTruthy();
    expect(within(first).getByText("Overdue")).toBeTruthy();
    expect(within(first).getByText("Omar Saleh (Teacher)")).toBeTruthy();
    expect(within(first).getByText("Layla Hassan (Parent)")).toBeTruthy();
    expect(within(first).getByText("Sami Hassan")).toBeTruthy();
    expect(within(first).getByText("Pending")).toBeTruthy();
    expect(
      within(first)
        .getByRole("link", { name: "Review report about Omar Saleh" })
        .getAttribute("href"),
    ).toBe("/portal/principal/message-reports/report-1");

    const second = rows.find((row) => within(row).queryByText("Spam"));
    if (!second) throw new Error("Spam row missing");
    expect(within(second).getByText("Normal")).toBeTruthy();
    expect(within(second).queryByText("Overdue")).toBeNull();
    expect(within(second).getByText("In review")).toBeTruthy();

    expect(screen.getByText("Showing 1–2 of 2")).toBeTruthy();
  });

  test("changing the status filter refetches with that status, and All drops the filter", async () => {
    await renderAs("PRINCIPAL");
    await screen.findByText("Harassment");

    fireEvent.click(screen.getByRole("combobox", { name: "Status" }));
    fireEvent.click(await screen.findByRole("option", { name: "Dismissed" }));

    await waitFor(() => {
      expect(getMock).toHaveBeenCalledWith(
        "/api/messaging/reports",
        expect.objectContaining({
          params: { query: { limit: 25, offset: 0, status: "dismissed" } },
        }),
      );
    });

    fireEvent.click(screen.getByRole("combobox", { name: "Status" }));
    fireEvent.click(await screen.findByRole("option", { name: "All" }));

    await waitFor(() => {
      expect(getMock).toHaveBeenCalledWith(
        "/api/messaging/reports",
        expect.objectContaining({ params: { query: { limit: 25, offset: 0 } } }),
      );
    });
  });

  test("shows the empty state when nothing matches", async () => {
    getMock.mockImplementationOnce(() =>
      Promise.resolve({ data: { reports: [], total: 0, limit: 25, offset: 0 } }),
    );
    await renderAs("PRINCIPAL");

    expect(await screen.findByText("No message reports match this filter.")).toBeTruthy();
  });

  test("shows the error state when the queue can't load", async () => {
    getMock.mockImplementationOnce(() => Promise.reject(new Error("boom")));
    await renderAs("PRINCIPAL");

    expect(await screen.findByText("Unable to load message reports.")).toBeTruthy();
  });

  test("a role without messageReport:review is redirected away", async () => {
    await renderAs("PARENT");

    expect(await screen.findByText("Portal home")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Message reports" })).toBeNull();
    expect(getMock).not.toHaveBeenCalled();
  });
});
