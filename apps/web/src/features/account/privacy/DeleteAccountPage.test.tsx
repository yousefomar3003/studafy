import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";

import { expectNoA11yViolations } from "../../../lib/test/axe";

let requests: unknown[] = [];

const getMock = mock((_path: string) => Promise.resolve({ data: requests }));
const postMock = mock((_path: string, options: { body: { request_type: string } }) =>
  Promise.resolve({
    data: {
      id: "dsr-1",
      request_type: options.body.request_type,
      subject_user_id: "user-1",
      status: "queued",
      created_at: "2026-09-22T09:00:00.000Z",
      completed_at: null,
      sla_due_at: "2026-10-22T09:00:00.000Z",
      download_url: null,
      download_url_expires_at: null,
      failure_message: null,
    },
  }),
);

mock.module("../../../lib/api", () => ({ api: { GET: getMock, POST: postMock } }));

const loadPage = async () => (await import("./DeleteAccountPage")).default;

async function renderPage() {
  const Page = await loadPage();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <Page />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  requests = [];
  getMock.mockClear();
  postMock.mockClear();
});

describe("DeleteAccountPage", () => {
  test("shows the delete action when there is no pending request", async () => {
    await renderPage();

    expect(await screen.findByRole("button", { name: "Delete my account" })).toBeTruthy();
  });

  test("asks for confirmation, and cancelling files no request", async () => {
    await renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Delete my account" }));
    expect(await screen.findByText("Delete your account?")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(postMock).not.toHaveBeenCalled();
  });

  test("confirming files a self-service erasure request", async () => {
    await renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Delete my account" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete account" }));

    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith(
        "/api/privacy/me/dsr",
        expect.objectContaining({ body: { request_type: "erasure" } }),
      );
    });
  });

  test("shows a pending request instead of the delete action", async () => {
    requests = [
      {
        id: "dsr-1",
        request_type: "erasure",
        subject_user_id: "user-1",
        status: "queued",
        created_at: "2026-09-22T09:00:00.000Z",
        completed_at: null,
        sla_due_at: "2026-10-22T09:00:00.000Z",
        download_url: null,
        download_url_expires_at: null,
        failure_message: null,
      },
    ];

    await renderPage();

    expect(await screen.findByText(/A deletion request is already in progress/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete my account" })).toBeNull();
  });

  test("has no accessibility violations", async () => {
    const { container } = await renderPage();
    await screen.findByRole("button", { name: "Delete my account" });

    await expectNoA11yViolations(container);
  });
});
