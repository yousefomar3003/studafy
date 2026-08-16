import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import type { ComponentType } from "react";

interface RequestInit {
  params?: { path?: Record<string, string> };
  body?: unknown;
}

const IMPORT_ID = "import-1";

function importRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: IMPORT_ID,
    school_id: "school-1",
    uploaded_by: "user-1",
    status: "validated",
    file_name: "students.csv",
    row_count: 2,
    valid_rows: 2,
    error_rows: 0,
    errors: [],
    summary: null,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    confirmed_at: null,
    completed_at: null,
    ...overrides,
  };
}

const getMock = mock((path: string, _init?: RequestInit) => {
  if (path === "/api/imports/students/template") {
    return Promise.resolve<unknown>({ data: "admission_number,email\n" });
  }
  return Promise.resolve<unknown>({ data: importRecord({ status: "completed" }) });
});
const postMock = mock((_path: string, _init?: RequestInit) =>
  Promise.resolve<unknown>({ data: importRecord({ status: "processing", confirmed_at: "now" }) }),
);

mock.module("../../../lib/api", () => ({ api: { GET: getMock, POST: postMock } }));
mock.module("../../../lib/auth", () => ({
  sessionStore: { getToken: async () => "test-token" },
}));

/** Minimal fake standing in for the real `XMLHttpRequest` — `uploadStudentImportCsv` (queries.ts)
 * uses raw XHR (not the typed `api` client) so it can report real upload-progress events, which
 * `fetch`-based mocks like the ones above can't produce. */
class FakeXhr {
  static nextStatus = 201;
  static nextResponseBody: unknown = importRecord();
  static lastInstance: FakeXhr | null = null;

  status = 0;
  response = "";
  upload: {
    onprogress:
      ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null;
  } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  open(_method: string, _url: string) {
    FakeXhr.lastInstance = this;
  }
  // `uploadStudentImportCsv` calls this for Content-Type/X-File-Name/Authorization; this test only
  // needs the response side, so recording headers isn't worth the extra state (see queries.test.ts's
  // FakeXhr for the version that does).
  setRequestHeader(_key: string, _value: string) {
    void _key;
  }
  getAllResponseHeaders() {
    return "content-type: application/json\r\n";
  }
  send(_body: unknown) {
    setTimeout(() => {
      this.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 });
      this.upload.onprogress?.({ lengthComputable: true, loaded: 100, total: 100 });
      this.status = FakeXhr.nextStatus;
      this.response = JSON.stringify(FakeXhr.nextResponseBody);
      this.onload?.();
    }, 0);
  }
}

// @ts-expect-error -- test double, not a full XMLHttpRequest implementation
globalThis.XMLHttpRequest = FakeXhr;

const loadImportStudentsPage = async () => (await import("./ImportStudentsPage")).default;

function renderPage(Page: ComponentType) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter>
          <Page />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function uploadFile() {
  const file = new File(["admission_number,email\nADM-1,a@b.com"], "students.csv", {
    type: "text/csv",
  });
  const input = screen.getByLabelText("Student CSV file") as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
  postMock.mockClear();
  FakeXhr.nextStatus = 201;
  FakeXhr.nextResponseBody = importRecord();
});

describe("ImportStudentsPage", () => {
  test("downloads the CSV template", async () => {
    await renderPage(await loadImportStudentsPage());

    fireEvent.click(screen.getByRole("button", { name: "Download CSV template" }));

    await waitFor(() => {
      expect(getMock.mock.calls.some(([path]) => path === "/api/imports/students/template")).toBe(
        true,
      );
    });
  });

  test("uploads a CSV, shows upload progress, then the validation report", async () => {
    FakeXhr.nextResponseBody = importRecord({ status: "validated", valid_rows: 2, error_rows: 0 });

    await renderPage(await loadImportStudentsPage());
    uploadFile();

    expect(await screen.findByLabelText("Upload progress")).toBeTruthy();

    const report = within(await screen.findByRole("region", { name: "Validation report" }));
    expect(report.getByText("Rows in file")).toBeTruthy();
    expect(report.getByRole("button", { name: "Confirm import (2 students)" })).toBeTruthy();
  });

  test("renders one actionable row per validation error, downloadable as a report", async () => {
    FakeXhr.nextResponseBody = importRecord({
      status: "uploaded",
      valid_rows: 1,
      error_rows: 1,
      errors: [{ line: 3, field: "email", message: "Invalid email address." }],
    });

    await renderPage(await loadImportStudentsPage());
    uploadFile();

    const grid = within(await screen.findByRole("region", { name: "Row-level validation errors" }));
    expect(grid.getByText("3")).toBeTruthy();
    expect(grid.getByText("email")).toBeTruthy();
    expect(grid.getByText("Invalid email address.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download error report" })).toBeTruthy();

    const confirmButton = screen.getByRole("button", { name: "Confirm import (1 student)" });
    expect(confirmButton.hasAttribute("disabled")).toBe(false);
  });

  test("disables confirm when every row failed validation", async () => {
    FakeXhr.nextResponseBody = importRecord({
      status: "uploaded",
      valid_rows: 0,
      error_rows: 1,
      errors: [{ line: 2, field: "admission_number", message: "Required." }],
    });

    await renderPage(await loadImportStudentsPage());
    uploadFile();

    const confirmButton = await screen.findByRole("button", {
      name: "Confirm import (0 students)",
    });
    expect(confirmButton.hasAttribute("disabled")).toBe(true);
  });

  test("confirming a validated import polls through to a completed summary", async () => {
    FakeXhr.nextResponseBody = importRecord({ status: "validated", valid_rows: 2, error_rows: 0 });
    getMock.mockImplementation((path: string) => {
      if (path === "/api/imports/students/template") {
        return Promise.resolve<unknown>({ data: "admission_number,email\n" });
      }
      return Promise.resolve<unknown>({
        data: importRecord({
          status: "completed",
          valid_rows: 2,
          summary: {
            students_created: 2,
            students_skipped: 0,
            parents_created: 1,
            parents_linked: 1,
          },
        }),
      });
    });

    await renderPage(await loadImportStudentsPage());
    uploadFile();

    fireEvent.click(await screen.findByRole("button", { name: "Confirm import (2 students)" }));

    await waitFor(() => {
      expect(
        postMock.mock.calls.some(([path]) => path === "/api/imports/students/{importId}/confirm"),
      ).toBe(true);
    });

    expect(await screen.findByText("Import complete.")).toBeTruthy();
    const summary = within(screen.getByRole("region", { name: "Import summary" }));
    expect(summary.getByText("Students created")).toBeTruthy();
    expect(summary.getByText("2")).toBeTruthy();
  });

  test("shows a failure panel and lets the user start over", async () => {
    FakeXhr.nextResponseBody = importRecord({ status: "validated", valid_rows: 2, error_rows: 0 });
    postMock.mockImplementation(() =>
      Promise.resolve<unknown>({ data: importRecord({ status: "failed" }) }),
    );

    await renderPage(await loadImportStudentsPage());
    uploadFile();
    fireEvent.click(await screen.findByRole("button", { name: "Confirm import (2 students)" }));

    expect(
      await screen.findByText(
        "The import failed while processing. No students were created from this file.",
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Start a new import" }));
    expect(await screen.findByLabelText("Student CSV file")).toBeTruthy();
  });
});
