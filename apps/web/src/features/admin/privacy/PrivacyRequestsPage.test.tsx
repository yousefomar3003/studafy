import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import { AuthProvider } from "../../../lib/auth";
import { expectNoA11yViolations } from "../../../lib/test/axe";
import { createTestSessionStore } from "../../../lib/test/session";

import type { ComponentType } from "react";

/**
 * Privacy requests page: lists the school's requests (an erased person shown as such), downloads a
 * finished export through a freshly signed link, shows an export whose file the retention sweep
 * deleted (30 days on) as such instead of offering a download that would fail, and files an erasure only once the admin ticks
 * that they understand it is permanent. Plus an accessibility pass.
 */

const EXPORT_DONE = {
  id: "dsr-1",
  request_type: "export",
  subject_user_id: "user-1",
  subject_display_name: "Lina Haddad",
  status: "completed",
  created_at: "2026-10-01T08:00:00.000Z",
  completed_at: "2026-10-01T09:00:00.000Z",
  sla_due_at: "2026-10-31T08:00:00.000Z",
  download_url: null,
  download_url_expires_at: null,
  export_deleted_at: null,
  failure_message: null,
};
const ERASED = {
  ...EXPORT_DONE,
  id: "dsr-2",
  request_type: "erasure",
  subject_user_id: "user-2",
  subject_display_name: "erased-3f2b",
};
/** Finished in September; its file was deleted 30 days later. */
const EXPORT_EXPIRED = {
  ...EXPORT_DONE,
  id: "dsr-4",
  subject_user_id: "user-4",
  subject_display_name: "Omar Saleh",
  completed_at: "2026-09-01T09:00:00.000Z",
  export_deleted_at: "2026-10-01T09:00:00.000Z",
};
/** Still stored when the list loaded, deleted by the time the admin clicks Download. */
const EXPORT_RACED = {
  ...EXPORT_DONE,
  id: "dsr-5",
  subject_user_id: "user-5",
  subject_display_name: "Huda Karim",
};
const SAM = { id: "user-3", display_name: "Sam Lee", email: "sam@example.test", roles: [] };

const getMock = mock((path: string, init?: unknown) => {
  switch (path) {
    case "/api/privacy/dsr":
      return Promise.resolve<unknown>({
        data: { requests: [EXPORT_DONE, ERASED, EXPORT_EXPIRED, EXPORT_RACED] },
      });
    case "/api/privacy/dsr/{requestId}": {
      const { requestId } = (init as { params: { path: { requestId: string } } }).params.path;
      if (requestId === EXPORT_RACED.id) {
        return Promise.resolve<unknown>({
          data: { ...EXPORT_RACED, export_deleted_at: "2026-11-01T09:00:00.000Z" },
        });
      }
      return Promise.resolve<unknown>({
        data: { ...EXPORT_DONE, download_url: "https://files.example.test/export.zip" },
      });
    }
    case "/api/users":
      return Promise.resolve<unknown>({ data: { users: [SAM] } });
    default:
      return Promise.resolve<unknown>({ data: undefined });
  }
});
const postMock = mock((_path: string, _init?: unknown) =>
  Promise.resolve<unknown>({ data: { ...EXPORT_DONE, id: "dsr-3", status: "queued" } }),
);
mock.module("../../../lib/api", () => ({ api: { GET: getMock, POST: postMock } }));

async function renderPage() {
  const Page: ComponentType = (await import("./PrivacyRequestsPage")).default;
  const store = await createTestSessionStore(["ORG_ADMIN"]);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <AuthProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <MemoryRouter>
            <main>
              <Page />
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
  postMock.mockClear();
});

describe("PrivacyRequestsPage", () => {
  test("lists requests and downloads a finished export through a fresh link", async () => {
    const opened: string[] = [];
    const originalOpen = window.open;
    window.open = ((url: string) => {
      opened.push(url);
      return null;
    }) as typeof window.open;
    try {
      await renderPage();

      expect(await screen.findByText("Lina Haddad")).toBeTruthy();
      // The erasure overwrote the name; the list says so instead of showing the placeholder.
      expect(screen.getByText("Erased person")).toBeTruthy();
      expect(screen.queryByText("erased-3f2b")).toBeNull();

      fireEvent.click(
        screen.getByRole("button", { name: "Download the data export for Lina Haddad" }),
      );
      await waitFor(() => expect(opened).toEqual(["https://files.example.test/export.zip"]));
      expect(getMock).toHaveBeenCalledWith("/api/privacy/dsr/{requestId}", {
        params: { path: { requestId: "dsr-1" } },
      });
    } finally {
      window.open = originalOpen;
    }
  });

  test("an export whose file was deleted after 30 days shows as such, with no download", async () => {
    await renderPage();

    const row = (await screen.findByText("Omar Saleh")).closest("tr")!;
    expect(within(row).getByText("Deleted after 30 days")).toBeTruthy();
    expect(within(row).queryByRole("button")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Download the data export for Omar Saleh" }),
    ).toBeNull();
    // The live export next to it still offers its download.
    expect(
      screen.getByRole("button", { name: "Download the data export for Lina Haddad" }),
    ).toBeTruthy();
  });

  test("an export deleted since the list loaded explains why instead of opening a link", async () => {
    const opened: string[] = [];
    const originalOpen = window.open;
    window.open = ((url: string) => {
      opened.push(url);
      return null;
    }) as typeof window.open;
    try {
      await renderPage();

      fireEvent.click(
        await screen.findByRole("button", { name: "Download the data export for Huda Karim" }),
      );
      expect(await screen.findByText("This export has been deleted")).toBeTruthy();
      expect(screen.queryByText("Couldn't get the download link. Try again.")).toBeNull();
      expect(opened).toEqual([]);
      // The list is fetched again so the row can show the export as deleted.
      await waitFor(() =>
        expect(getMock.mock.calls.filter(([path]) => path === "/api/privacy/dsr")).toHaveLength(2),
      );
    } finally {
      window.open = originalOpen;
    }
  });

  test("files an erasure only after the admin confirms it is permanent", async () => {
    await renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "New request" }));
    const dialog = await screen.findByRole("dialog", { name: "New privacy request" });
    fireEvent.change(within(dialog).getByRole("searchbox", { name: "Person" }), {
      target: { value: "Sam" },
    });
    fireEvent.click(await within(dialog).findByRole("button", { name: /Sam Lee/ }));
    fireEvent.click(within(dialog).getByRole("radio", { name: "Erasure" }));

    const submit = within(dialog).getByRole("button", { name: "Erase their data" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(
      within(dialog).getByRole("checkbox", {
        name: "I understand this person's data will be erased for good",
      }),
    );
    fireEvent.click(submit);

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith("/api/privacy/dsr", {
        body: { subject_user_id: "user-3", request_type: "erasure" },
      }),
    );
    expect(await screen.findByText("Erasure requested for Sam Lee")).toBeTruthy();
  });

  test("has no accessibility violations", async () => {
    const { container } = await renderPage();
    await screen.findByText("Lina Haddad");
    await expectNoA11yViolations(container);
  });
});
