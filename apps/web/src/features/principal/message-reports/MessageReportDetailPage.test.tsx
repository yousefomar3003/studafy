import { ApiError } from "@studafy/api-client";
import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { reportDetailFixture } from "./test-fixtures";

import type { MessageReportDetail } from "./queries";
import type { ComponentType } from "react";

interface RequestInit {
  params?: { path?: Record<string, string> };
  body?: { status: string; resolution_note?: string };
}

let report: MessageReportDetail = reportDetailFixture();
let patchError: unknown = null;

const getMock = mock((_path: string, _init?: RequestInit) =>
  Promise.resolve<unknown>({ data: { report } }),
);

const patchMock = mock((_path: string, init?: RequestInit) => {
  if (patchError) return Promise.reject(patchError);
  report = {
    ...report,
    status: (init?.body?.status ?? report.status) as MessageReportDetail["status"],
    resolution_note: init?.body?.resolution_note ?? report.resolution_note,
  };
  return Promise.resolve<unknown>({ data: { report } });
});

mock.module("../../../lib/api", () => ({ api: { GET: getMock, PATCH: patchMock } }));

const loadDetailPage = async (): Promise<ComponentType> =>
  (await import("./MessageReportDetailPage")).default;

function renderPage(Page: ComponentType) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/portal/principal/message-reports/report-1"]}>
          <Routes>
            <Route path="/portal/principal/message-reports/:reportId" element={<Page />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
  patchMock.mockClear();
  report = reportDetailFixture();
  patchError = null;
});

describe("MessageReportDetailPage", () => {
  test("renders the report header with the overdue warning, block state and decoded details", async () => {
    renderPage(await loadDetailPage());

    expect(await screen.findByRole("heading", { name: "Harassment" })).toBeTruthy();
    expect(getMock).toHaveBeenCalledWith(
      "/api/messaging/reports/{reportId}",
      expect.objectContaining({ params: { path: { reportId: "report-1" } } }),
    );
    expect(screen.getByText(/^Overdue — a response was due by/)).toBeTruthy();
    expect(screen.getByText("Urgent")).toBeTruthy();
    expect(screen.getByText("Pending")).toBeTruthy();
    expect(screen.getByText("Layla Hassan (Parent)")).toBeTruthy();
    expect(screen.getByText("Omar Saleh (Teacher)")).toBeTruthy();
    expect(screen.getByText("Sami Hassan")).toBeTruthy();
    expect(screen.getByText("Blocked")).toBeTruthy();
    expect(screen.getByText("He keeps messaging late at night & it's upsetting.")).toBeTruthy();
  });

  test("renders the transcript oldest first, highlights the reported message and decodes bodies as text", async () => {
    const { container } = renderPage(await loadDetailPage());
    await screen.findByRole("heading", { name: "Harassment" });

    const transcript = screen.getByRole("list", { name: "Conversation evidence" });
    const items = within(transcript).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0] as HTMLElement).getByText("Is the homework due tomorrow?")).toBeTruthy();

    const reported = items[1] as HTMLElement;
    expect(reported.getAttribute("data-reported")).toBe("true");
    expect(within(reported).getByText("Reported message")).toBeTruthy();
    // Entities decoded to literal text — never parsed as markup.
    expect(within(reported).getByText("Stop asking <b>me</b> questions")).toBeTruthy();
    expect(container.querySelector(".message-reports__message-body b")).toBeNull();
    expect((items[0] as HTMLElement).getAttribute("data-reported")).toBeNull();
  });

  test("shows image thumbnails that open full size in a new tab, and a placeholder when unavailable", async () => {
    renderPage(await loadDetailPage());
    await screen.findByRole("heading", { name: "Harassment" });

    const link = screen.getByRole("link", {
      name: "Open full-size image sent by Omar Saleh in a new tab",
    });
    expect(link.getAttribute("href")).toBe("https://storage.example.test/attachment-1.png?sig=abc");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    const img = within(link).getByRole("img", { name: "Image sent by Omar Saleh" });
    expect(img.getAttribute("src")).toBe("https://storage.example.test/attachment-1.png?sig=abc");
    expect(screen.getByText("Image unavailable")).toBeTruthy();
  });

  test("Refresh images refetches the report for fresh signed URLs", async () => {
    renderPage(await loadDetailPage());
    await screen.findByRole("heading", { name: "Harassment" });
    expect(getMock).toHaveBeenCalledTimes(1);

    report = reportDetailFixture({
      messages: reportDetailFixture().messages.map((message) => ({
        ...message,
        attachments: message.attachments.map((attachment) => ({
          ...attachment,
          download_url: attachment.download_url ? `${attachment.download_url}-fresh` : null,
        })),
      })),
    });
    fireEvent.click(screen.getByRole("button", { name: "Refresh images" }));

    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      const img = screen.getByRole("img", { name: "Image sent by Omar Saleh" });
      expect(img.getAttribute("src")).toBe(
        "https://storage.example.test/attachment-1.png?sig=abc-fresh",
      );
    });
  });

  test("Start review PATCHes in_review", async () => {
    renderPage(await loadDetailPage());
    await screen.findByRole("heading", { name: "Harassment" });

    fireEvent.click(screen.getByRole("button", { name: "Start review" }));

    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith(
        "/api/messaging/reports/{reportId}",
        expect.objectContaining({
          params: { path: { reportId: "report-1" } },
          body: { status: "in_review" },
        }),
      );
    });
    expect(await screen.findByText("Review started")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Start review" })).toBeNull());
  });

  test("closing a report requires a resolution note, then PATCHes it with the status", async () => {
    renderPage(await loadDetailPage());
    await screen.findByRole("heading", { name: "Harassment" });

    fireEvent.click(screen.getByRole("button", { name: "Mark actioned" }));
    const dialog = await screen.findByRole("dialog", { name: "Mark report as actioned" });

    fireEvent.click(within(dialog).getByRole("button", { name: "Mark actioned" }));
    expect(
      await within(dialog).findByText("Enter a resolution note (up to 2000 characters)."),
    ).toBeTruthy();
    expect(patchMock).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByLabelText("Resolution note"), {
      target: { value: "  Spoke with the teacher; warning issued.  " },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Mark actioned" }));

    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith(
        "/api/messaging/reports/{reportId}",
        expect.objectContaining({
          params: { path: { reportId: "report-1" } },
          body: { status: "actioned", resolution_note: "Spoke with the teacher; warning issued." },
        }),
      );
    });
    expect(await screen.findByText("Report marked as actioned")).toBeTruthy();
  });

  test("dismissing sends the dismissed status with its note", async () => {
    renderPage(await loadDetailPage());
    await screen.findByRole("heading", { name: "Harassment" });

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    const dialog = await screen.findByRole("dialog", { name: "Dismiss report" });
    fireEvent.change(within(dialog).getByLabelText("Resolution note"), {
      target: { value: "Normal scheduling message." },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Dismiss report" }));

    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith(
        "/api/messaging/reports/{reportId}",
        expect.objectContaining({
          body: { status: "dismissed", resolution_note: "Normal scheduling message." },
        }),
      );
    });
  });

  test("a 409 invalid transition toasts and refetches the report", async () => {
    patchError = new ApiError({
      status: 409,
      title: "Conflict",
      code: "MESSAGE_REPORT_INVALID_TRANSITION",
      detail: "Cannot move report from actioned to in_review",
      instance: null,
      type: null,
      request_id: null,
      problem: null,
    });
    renderPage(await loadDetailPage());
    await screen.findByRole("heading", { name: "Harassment" });
    expect(getMock).toHaveBeenCalledTimes(1);

    report = reportDetailFixture({
      status: "actioned",
      is_overdue: false,
      resolution_note: "Handled by another reviewer.",
      reviewed_by: { id: "admin-1", name: "Huda Nasser" },
      reviewed_at: "2026-10-12T09:00:00.000Z",
    });
    fireEvent.click(screen.getByRole("button", { name: "Start review" }));

    expect(await screen.findByText("This report was already updated")).toBeTruthy();
    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Handled by another reviewer.")).toBeTruthy();
  });

  test("a closed report shows its resolution and offers no workflow actions", async () => {
    report = reportDetailFixture({
      status: "dismissed",
      is_overdue: false,
      resolution_note: "Not a policy violation &amp; parent informed.",
      reviewed_by: { id: "principal-1", name: "Huda Nasser" },
      reviewed_at: "2026-10-12T09:00:00.000Z",
    });
    renderPage(await loadDetailPage());
    await screen.findByRole("heading", { name: "Harassment" });

    expect(screen.getByText("Not a policy violation & parent informed.")).toBeTruthy();
    expect(screen.getByText("Huda Nasser")).toBeTruthy();
    expect(screen.queryByText(/^Overdue/)).toBeNull();
    for (const name of ["Start review", "Mark actioned", "Dismiss"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });

  test("a missing report shows the not-found message", async () => {
    getMock.mockImplementationOnce(() =>
      Promise.reject(
        new ApiError({
          status: 404,
          title: "Not Found",
          code: "MESSAGE_REPORT_NOT_FOUND",
          detail: null,
          instance: null,
          type: null,
          request_id: null,
          problem: null,
        }),
      ),
    );
    renderPage(await loadDetailPage());

    expect(
      await screen.findByText("This report doesn't exist or is no longer available."),
    ).toBeTruthy();
  });
});
