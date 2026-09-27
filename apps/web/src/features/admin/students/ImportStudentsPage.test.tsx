import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import { expectNoA11yViolations } from "../../../lib/test/axe";

import type { ComponentType } from "react";

interface RequestInit {
  params?: { path?: Record<string, string> };
  body?: unknown;
}

const IMPORT_ID = "import-1";

const TEMPLATE_HEADERS = ["admission_number", "email", "first_name", "last_name"];
const TEMPLATE_MAPPING = {
  admission_number: "admission_number",
  email: "email",
  first_name: "first_name",
  last_name: "last_name",
};

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
    confirmed_by: null,
    header_line: 1,
    source_headers: TEMPLATE_HEADERS,
    column_mapping: TEMPLATE_MAPPING,
    ...overrides,
  };
}

function importDiff() {
  return {
    import_id: IMPORT_ID,
    totals: {
      create: 1,
      update: 1,
      unchanged: 0,
      conflict: 0,
      parents_created: 0,
      links_created: 0,
      links_updated: 0,
    },
    rows: [
      {
        line_number: 2,
        admission_number: "ADM-1",
        action: "create",
        changes: {},
        conflict: null,
        parent: null,
        link: null,
      },
      {
        line_number: 3,
        admission_number: "ADM-2",
        action: "update",
        changes: { first_name: { from: "Sam", to: "Samuel" } },
        conflict: null,
        parent: null,
        link: null,
      },
    ],
  };
}

let savedMappings: unknown[] = [];

/** The GET routes every review-step render hits, shared so a test overriding one path keeps the
 * others working. */
function defaultGet(path: string): Promise<unknown> {
  if (path === "/api/imports/students/template") {
    return Promise.resolve({ data: "admission_number,email\n" });
  }
  if (path === "/api/imports/students/mappings") {
    return Promise.resolve({ data: { mappings: savedMappings } });
  }
  if (path === "/api/imports/students/{importId}/diff") {
    return Promise.resolve({ data: importDiff() });
  }
  return Promise.resolve({ data: importRecord({ status: "completed" }) });
}

const getMock = mock((path: string, _init?: RequestInit) => defaultGet(path));
const postMock = mock((_path: string, _init?: RequestInit) =>
  Promise.resolve<unknown>({ data: importRecord({ status: "processing", confirmed_at: "now" }) }),
);

const putMock = mock((_path: string, _init?: RequestInit) =>
  Promise.resolve<unknown>({ data: importRecord() }),
);

mock.module("../../../lib/api", () => ({ api: { GET: getMock, POST: postMock, PUT: putMock } }));
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

/** Picks `option` in the custom `Select` labelled `label` (a combobox button plus a listbox). */
function choose(label: string, option: string) {
  fireEvent.click(screen.getByRole("combobox", { name: new RegExp(`^${label}`) }));
  fireEvent.click(screen.getByRole("option", { name: option }));
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
  getMock.mockImplementation((path: string) => defaultGet(path));
  postMock.mockClear();
  putMock.mockClear();
  savedMappings = [];
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
    expect(screen.getByRole("button", { name: "Confirm import (2 students)" })).toBeTruthy();
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
      if (path !== "/api/imports/students/{importId}") return defaultGet(path);
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

  test("maps a non-template CSV end to end: suggest, fix, apply, preview, confirm", async () => {
    FakeXhr.nextResponseBody = importRecord({
      status: "uploaded",
      valid_rows: 0,
      error_rows: 2,
      header_line: 3,
      source_headers: ["Student ID", "Given Name", "Surname", "Contact"],
      // What the server suggests from its alias list: everything but the email.
      column_mapping: {
        admission_number: "Student ID",
        first_name: "Given Name",
        last_name: "Surname",
      },
      errors: [{ line: 3, field: "email", message: 'Map a column to "email".' }],
    });
    putMock.mockImplementation((_path: string, init?: RequestInit) =>
      Promise.resolve<unknown>({
        data: importRecord({
          status: "validated",
          header_line: 3,
          source_headers: ["Student ID", "Given Name", "Surname", "Contact"],
          column_mapping: (init?.body as { column_mapping: unknown }).column_mapping,
          updated_at: "2026-08-01T00:01:00.000Z",
        }),
      }),
    );

    await renderPage(await loadImportStudentsPage());
    uploadFile();

    const mapping = within(await screen.findByRole("region", { name: "Column mapping" }));
    expect(
      mapping.getByText("4 columns found on line 3 of students.csv.", { exact: false }),
    ).toBeTruthy();
    // "Given Name" and "Surname" are aliases the server matched; "Student ID" too.
    expect(mapping.getAllByText("High: known alternative name")).toHaveLength(3);
    expect(
      mapping.getByText("3 of 4 required fields mapped. Missing: Student email."),
    ).toBeTruthy();

    const confirm = screen.getByRole("button", { name: /^Confirm import/ });
    expect(confirm.hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByText(
        "Map a column to every required field before confirming. Missing: Student email.",
      ),
    ).toBeTruthy();
    // No preview for a mapping that stages no records.
    expect(screen.queryByRole("region", { name: "Import preview" })).toBeNull();

    choose("Student email", "Contact");
    expect(mapping.getByText("4 of 4 required fields mapped.")).toBeTruthy();
    expect(mapping.getByText("Chosen manually")).toBeTruthy();
    expect(
      screen.getByText("You changed the mapping. Apply it to re-check the file before confirming."),
    ).toBeTruthy();

    fireEvent.click(mapping.getByRole("button", { name: "Apply mapping" }));

    await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
    const [path, init] = putMock.mock.calls[0]!;
    expect(path).toBe("/api/imports/students/{importId}/mapping");
    expect(init?.body).toEqual({
      column_mapping: {
        admission_number: "Student ID",
        email: "Contact",
        first_name: "Given Name",
        last_name: "Surname",
      },
      save_as: undefined,
    });

    const preview = within(await screen.findByRole("region", { name: "Import preview" }));
    expect(await preview.findByText("New students")).toBeTruthy();
    expect(preview.getByText("First name: Sam → Samuel")).toBeTruthy();

    const enabledConfirm = screen.getByRole("button", { name: "Confirm import (2 students)" });
    expect(enabledConfirm.hasAttribute("disabled")).toBe(false);
  });

  test("applies a saved mapping in one click and hides ones that don't fit the file", async () => {
    savedMappings = [
      {
        id: "mapping-1",
        name: "SIS export",
        column_mapping: TEMPLATE_MAPPING,
        created_by: "user-1",
        created_at: "2026-08-01T00:00:00.000Z",
        updated_at: "2026-08-01T00:00:00.000Z",
      },
      {
        id: "mapping-2",
        name: "Old export",
        column_mapping: { ...TEMPLATE_MAPPING, status: "Enrolment" },
        created_by: "user-1",
        created_at: "2026-08-01T00:00:00.000Z",
        updated_at: "2026-08-01T00:00:00.000Z",
      },
    ];
    FakeXhr.nextResponseBody = importRecord({ column_mapping: {} });

    await renderPage(await loadImportStudentsPage());
    uploadFile();
    await screen.findByRole("region", { name: "Column mapping" });

    fireEvent.click(await screen.findByRole("combobox", { name: /^Use a saved mapping/ }));
    const unfit = screen.getByRole("option", { name: "Old export (columns not in this file)" });
    expect(unfit.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(screen.getByRole("option", { name: "SIS export" }));

    await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
    expect(putMock.mock.calls[0]![1]?.body).toEqual({
      column_mapping: TEMPLATE_MAPPING,
      save_as: undefined,
    });
  });

  test("saves the mapping under a name, and keeps the name when the server refuses it", async () => {
    putMock.mockImplementation(() =>
      Promise.reject(Object.assign(new Error("Conflict"), { status: 409 })),
    );

    await renderPage(await loadImportStudentsPage());
    uploadFile();
    const mapping = within(await screen.findByRole("region", { name: "Column mapping" }));

    const name = mapping.getByLabelText("Save as (optional)") as HTMLInputElement;
    fireEvent.change(name, { target: { value: "SIS export" } });
    fireEvent.click(mapping.getByRole("button", { name: "Save mapping" }));

    await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
    expect(putMock.mock.calls[0]![1]?.body).toEqual({
      column_mapping: TEMPLATE_MAPPING,
      save_as: "SIS export",
    });
    expect(await screen.findByText("Couldn't apply the mapping. Please try again.")).toBeTruthy();
    expect(name.value).toBe("SIS export");
  });

  test("the mapping step has no accessibility violations", async () => {
    const { container } = await renderPage(await loadImportStudentsPage());
    uploadFile();
    await screen.findByRole("region", { name: "Import preview" });
    await screen.findByText("New students");

    await expectNoA11yViolations(container);
  });
});
