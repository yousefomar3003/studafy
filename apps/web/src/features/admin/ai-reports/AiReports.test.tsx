import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { AuthProvider } from "../../../lib/auth";
import { expectNoA11yViolations } from "../../../lib/test/axe";
import { createTestSessionStore } from "../../../lib/test/session";

import type { ComponentType } from "react";

/**
 * AI content moderation: the queue names each report's student and flags an overdue one; the
 * detail keeps the reported text hidden until asked, and escalating needs a note.
 */

const REPORT = {
  id: "report-1",
  student_id: "student-1",
  content_type: "ask_answer",
  content_id: null,
  source: "user_report",
  reporter_id: "user-9",
  reason_category: "child_safety",
  reason: "It told me to keep a secret from my parents.",
  priority: "urgent",
  respond_by: "2026-10-28T08:00:00.000Z",
  overdue: true,
  status: "pending",
  resolution_note: null,
  reviewed_by: null,
  reviewed_at: null,
  created_at: "2026-10-27T08:00:00.000Z",
};

const getMock = mock((path: string, _init?: unknown) => {
  switch (path) {
    case "/api/ai/moderation/reports":
      return Promise.resolve<unknown>({ data: { reports: [REPORT], total: 1 } });
    case "/api/ai/moderation/reports/{reportId}":
      return Promise.resolve<unknown>({
        data: { ...REPORT, content_snapshot: "The reported answer text." },
      });
    case "/api/students/{studentId}":
      return Promise.resolve<unknown>({
        data: { id: "student-1", first_name: "Lina", last_name: "Haddad", preferred_name: null },
      });
    default:
      return Promise.resolve<unknown>({ data: undefined });
  }
});
const patchMock = mock((_path: string, _init?: unknown) =>
  Promise.resolve<unknown>({ data: { ...REPORT, status: "escalated", content_snapshot: "" } }),
);
mock.module("../../../lib/api", () => ({ api: { GET: getMock, PATCH: patchMock } }));

async function renderAt(path: string) {
  const List: ComponentType = (await import("./AiReportsListPage")).default;
  const Detail: ComponentType = (await import("./AiReportDetailPage")).default;
  const store = await createTestSessionStore(["ORG_ADMIN"]);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <AuthProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <MemoryRouter initialEntries={[path]}>
            <main>
              <Routes>
                <Route path="/portal/admin/ai-reports" element={<List />} />
                <Route path="/portal/admin/ai-reports/:reportId" element={<Detail />} />
              </Routes>
            </main>
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>
    </AuthProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
  patchMock.mockClear();
});

describe("AI content reports", () => {
  test("the queue names the student and flags an overdue urgent report", async () => {
    await renderAt("/portal/admin/ai-reports");

    expect(await screen.findByText("Lina Haddad")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Child safety" }).getAttribute("href")).toBe(
      "/portal/admin/ai-reports/report-1",
    );
    expect(screen.getByText("Urgent")).toBeTruthy();
    expect(screen.getByText(/^Overdue since/)).toBeTruthy();
  });

  test("hides the reported text until asked, and escalating requires a note", async () => {
    await renderAt("/portal/admin/ai-reports/report-1");

    await screen.findByRole("heading", { name: "Child safety" });
    expect(screen.queryByText("The reported answer text.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show the content" }));
    expect(screen.getByText("The reported answer text.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Escalate" }));
    const dialog = await screen.findByRole("dialog", { name: "Escalate this report" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Escalate" }));
    expect(await within(dialog).findByText("Write a note before you continue.")).toBeTruthy();
    expect(patchMock).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByRole("textbox", { name: "Note" }), {
      target: { value: "Referred to the school social worker, case 4471." },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Escalate" }));
    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith("/api/ai/moderation/reports/{reportId}", {
        params: { path: { reportId: "report-1" } },
        body: {
          status: "escalated",
          resolution_note: "Referred to the school social worker, case 4471.",
        },
      }),
    );
    expect(await screen.findByText("Report escalated")).toBeTruthy();
  });

  test("the queue and the detail have no accessibility violations", async () => {
    const list = await renderAt("/portal/admin/ai-reports");
    await screen.findByText("Lina Haddad");
    await expectNoA11yViolations(list.container);
    cleanup();

    const detail = await renderAt("/portal/admin/ai-reports/report-1");
    await screen.findByRole("heading", { name: "Child safety" });
    await expectNoA11yViolations(detail.container);
  });
});
