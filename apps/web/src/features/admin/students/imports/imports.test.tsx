import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { expectNoA11yViolations } from "../../../../lib/test/axe";

import type { ReactNode } from "react";

/**
 * Import history, one import's unmapped columns, and mapping a column to a record field
 * (docs/modules/student-import-mapping-guide.md "Import history and unmapped columns"). Each state
 * is audited with axe inside a `<main>`, as RootLayout renders routes.
 */

interface Init {
  params?: { path?: Record<string, string>; query?: Record<string, unknown> };
  body?: unknown;
}

const IMPORT_ID = "11111111-1111-4111-8111-111111111111";

function importRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: IMPORT_ID,
    school_id: "school-1",
    uploaded_by: "user-1",
    confirmed_by: "user-1",
    status: "completed",
    file_name: "sis-export.csv",
    row_count: 3,
    valid_rows: 3,
    error_rows: 0,
    header_line: 1,
    source_headers: ["Student ID", "First", "Last", "Civil ID", "Bus stop"],
    column_mapping: { admission_number: "Student ID", first_name: "First", last_name: "Last" },
    errors: [],
    summary: {
      students_created: 2,
      students_updated: 1,
      students_skipped: 0,
      parents_created: 0,
      parents_linked: 0,
    },
    created_at: "2026-10-20T09:30:00.000Z",
    updated_at: "2026-10-20T09:31:00.000Z",
    confirmed_at: "2026-10-20T09:30:30.000Z",
    completed_at: "2026-10-20T09:31:00.000Z",
    source_file: {
      file_name: "sis-export.csv",
      size_bytes: 2048,
      uploaded_at: "2026-10-20T09:30:00.000Z",
      stored: true,
      expires_at: "2027-04-18T09:30:00.000Z",
      removed_at: null,
      removed_reason: null,
    },
    uploaded_by_name: "Amal Admin",
    confirmed_by_name: "Amal Admin",
    unmapped_column_count: 2,
    cells_available: true,
    ...overrides,
  };
}

function columns(overrides: Record<string, unknown> = {}) {
  return {
    import_id: IMPORT_ID,
    status: "completed",
    cells_available: true,
    can_apply: true,
    cells_expire_at: "2027-04-18T09:30:00.000Z",
    columns: [
      {
        position: 3,
        header: "Civil ID",
        non_empty_count: 3,
        student_count: 3,
        parent_count: 0,
        suggested_field_type: "short_text",
        suggested_options: [],
        suggested_sensitive: true,
        sensitive_reason: "label",
        applied: null,
      },
      {
        position: 4,
        header: "Bus stop",
        non_empty_count: 2,
        student_count: 2,
        parent_count: 0,
        suggested_field_type: "short_text",
        suggested_options: [],
        suggested_sensitive: false,
        sensitive_reason: null,
        applied: null,
      },
    ],
    ...overrides,
  };
}

const PREVIEW = {
  import_id: IMPORT_ID,
  position: 3,
  header: "Civil ID",
  subject_kind: "student",
  field: {
    id: null,
    field_type: "short_text",
    label_en: "Civil ID",
    label_ar: "Civil ID",
    sensitivity: "sensitive",
  },
  totals: { write: 2, unchanged: 0, kept: 0, invalid: 1, empty: 0, conflict: 0 },
  rows: [
    {
      line_number: 2,
      subject_id: "s-1",
      name: "Rana Haddad",
      admission_number: "S-1",
      status: "write",
      replaces_existing: false,
      value: null,
      mask: "•••• 2345",
      current_value: null,
      current_mask: null,
      reason: null,
    },
    {
      line_number: 3,
      subject_id: "s-2",
      name: "Omar Haddad",
      admission_number: "S-2",
      status: "write",
      replaces_existing: false,
      value: null,
      mask: "•••• 4321",
      current_value: null,
      current_mask: null,
      reason: null,
    },
    {
      line_number: 4,
      subject_id: "s-3",
      name: "Huda Saleh",
      admission_number: "S-3",
      status: "invalid",
      replaces_existing: false,
      value: null,
      mask: null,
      current_value: null,
      current_mask: null,
      reason: "RECORD_VALUE_TOO_LONG",
    },
  ],
  preview_token: "a".repeat(64),
};

let columnsResponse = columns();

function defaultGet(path: string): Promise<unknown> {
  switch (path) {
    case "/api/imports/students":
      return Promise.resolve({
        data: {
          imports: [
            importRecord(),
            importRecord({
              id: "22222222-2222-4222-8222-222222222222",
              file_name: "old.csv",
              source_file: null,
              unmapped_column_count: 0,
              summary: null,
              status: "failed",
            }),
          ],
          next_cursor: null,
        },
      });
    case "/api/imports/students/settings":
      return Promise.resolve({
        data: {
          source_retention_days: 180,
          default_retention_days: 180,
          max_retention_days: 180,
          updated_at: null,
        },
      });
    case "/api/imports/students/{importId}":
      return Promise.resolve({ data: importRecord() });
    case "/api/imports/students/{importId}/columns":
      return Promise.resolve({ data: columnsResponse });
    case "/api/imports/students/{importId}/source":
      return Promise.resolve({
        data: {
          url: "https://storage.example/file?signed",
          expires_at: "2026-11-01T00:01:00.000Z",
        },
      });
    case "/api/record-forms/{subjectKind}":
      return Promise.resolve({
        data: {
          subject_kind: "student",
          version: 1,
          fields: [
            {
              id: "f-bus",
              field_type: "short_text",
              label_en: "Bus stop",
              label_ar: "موقف",
              help_en: null,
              help_ar: null,
              required: false,
              options: [],
              sort_order: 0,
              visibility: "staff_only",
              sensitivity: "standard",
              has_expiry: false,
            },
            {
              id: "f-doc",
              field_type: "document",
              label_en: "Passport scan",
              label_ar: "جواز",
              help_en: null,
              help_ar: null,
              required: false,
              options: [],
              sort_order: 1,
              visibility: "staff_only",
              sensitivity: "sensitive",
              has_expiry: false,
            },
          ],
        },
      });
    default:
      return Promise.resolve({ data: undefined });
  }
}

function defaultPost(path: string): Promise<unknown> {
  if (path === "/api/imports/students/{importId}/columns/preview")
    return Promise.resolve({ data: PREVIEW });
  if (path === "/api/imports/students/{importId}/columns/apply") {
    return Promise.resolve({
      data: {
        import_id: IMPORT_ID,
        position: 3,
        field_id: "f-new",
        field_created: true,
        written: 2,
        totals: PREVIEW.totals,
      },
    });
  }
  return Promise.resolve({ data: undefined });
}

const getMock = mock((path: string, _init?: Init) => defaultGet(path));
const postMock = mock((path: string, _init?: Init) => defaultPost(path));
const putMock = mock((_path: string, init?: Init) =>
  Promise.resolve<unknown>({
    data: {
      source_retention_days: (init?.body as { source_retention_days: number })
        .source_retention_days,
      default_retention_days: 180,
      max_retention_days: 180,
      updated_at: "2026-11-01T00:00:00.000Z",
    },
  }),
);
const deleteMock = mock((_path: string, _init?: Init) =>
  Promise.resolve<unknown>({ data: undefined }),
);

mock.module("../../../../lib/api", () => ({
  api: { GET: getMock, POST: postMock, PUT: putMock, DELETE: deleteMock },
}));

const assignMock = mock((_url: string) => undefined);
Object.defineProperty(window, "location", {
  configurable: true,
  value: { ...window.location, assign: assignMock },
});

function renderAt(path: string, element: ReactNode, routePath: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <main>
            <Routes>
              <Route path={routePath} element={element} />
            </Routes>
          </main>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

async function renderHistory() {
  const Page = (await import("./ImportHistoryPage")).default;
  return renderAt("/portal/admin/students/imports", <Page />, "/portal/admin/students/imports");
}

async function renderDetail() {
  const Page = (await import("./ImportDetailPage")).default;
  return renderAt(
    `/portal/admin/students/imports/${IMPORT_ID}`,
    <Page />,
    "/portal/admin/students/imports/:importId",
  );
}

afterEach(() => {
  cleanup();
  for (const fn of [getMock, postMock, putMock, deleteMock, assignMock]) fn.mockClear();
  getMock.mockImplementation((path: string) => defaultGet(path));
  postMock.mockImplementation((path: string) => defaultPost(path));
  columnsResponse = columns();
});

describe("ImportHistoryPage", () => {
  test("lists imports newest first with outcome, who ran them and their original file", async () => {
    const { container } = await renderHistory();
    const table = await screen.findByRole("table", { name: "Student imports" });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(within(rows[1]!).getByText("sis-export.csv")).toBeTruthy();
    expect(within(rows[1]!).getByText("Completed")).toBeTruthy();
    expect(within(rows[1]!).getByText("Amal Admin")).toBeTruthy();
    expect(within(rows[1]!).getByText("2 created, 1 updated")).toBeTruthy();
    expect(within(rows[1]!).getByRole("link", { name: "2 unused columns" })).toBeTruthy();
    expect(
      within(rows[2]!).getByText("Not kept (uploaded before originals were kept)"),
    ).toBeTruthy();
    expect(within(rows[2]!).getByText("All used")).toBeTruthy();
    await expectNoA11yViolations(container);
  });

  test("downloads through a short-lived URL, and deletes only after confirming", async () => {
    await renderHistory();
    fireEvent.click(
      await screen.findByRole("button", { name: "Download original file sis-export.csv" }),
    );
    await waitFor(() =>
      expect(assignMock).toHaveBeenCalledWith("https://storage.example/file?signed"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete original file sis-export.csv" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete the original file?" });
    expect(deleteMock).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete file" }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledTimes(1));
    expect(deleteMock.mock.calls[0]![1]?.params?.path).toEqual({ importId: IMPORT_ID });
  });

  test("shortens retention, and refuses more than the maximum", async () => {
    await renderHistory();
    const input = (await screen.findByLabelText("Days to keep")) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("180"));

    fireEvent.change(input, { target: { value: "200" } });
    expect(screen.getByText("Enter a whole number from 1 to 180.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(input, { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved. Files are kept for 30 days.")).toBeTruthy();
    expect(putMock.mock.calls[0]![1]?.body).toEqual({ source_retention_days: 30 });
  });
});

describe("ImportDetailPage", () => {
  test("lists unused columns with suggestions and flags sensitive-looking ones", async () => {
    const { container } = await renderDetail();
    expect(await screen.findByRole("heading", { name: "Import: sis-export.csv" })).toBeTruthy();
    const list = await screen.findByRole("list");
    expect(within(list).getByText("Civil ID")).toBeTruthy();
    expect(within(list).getAllByText("Looks sensitive")).toHaveLength(1);
    expect(within(list).getByText(/3 values · Looks like: Short text/)).toBeTruthy();
    await expectNoA11yViolations(container);
  });

  test("cannot map before completion", async () => {
    columnsResponse = columns({ status: "validated", can_apply: false, cells_expire_at: null });
    await renderDetail();
    const button = (await screen.findByRole("button", {
      name: "Map column Civil ID",
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText("Columns can be mapped once the import has completed.")).toBeTruthy();
  });

  test("previews a new sensitive field masked, then writes only on confirm with the token", async () => {
    await renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: "Map column Civil ID" }));
    const dialog = await screen.findByRole("dialog", { name: "Map “Civil ID”" });

    // Suggested as sensitive, named after the column.
    const sensitive = within(dialog).getByRole("checkbox", {
      name: /Sensitive field/,
    }) as HTMLInputElement;
    expect(sensitive.checked).toBe(true);
    expect(
      (within(dialog).getByLabelText(/Field name \(English\)/) as HTMLInputElement).value,
    ).toBe("Civil ID");

    const write = within(dialog).getByRole("button", {
      name: "Write to 0 people",
    }) as HTMLButtonElement;
    expect(write.disabled).toBe(true);

    fireEvent.click(within(dialog).getByRole("button", { name: "Preview" }));
    const preview = await within(dialog).findByRole("table", {
      name: "What “Civil ID” would write",
    });
    expect(postMock.mock.calls[0]![1]?.body).toMatchObject({
      position: 3,
      subject_kind: "student",
      overwrite: false,
      new_field: { label_en: "Civil ID", field_type: "short_text", sensitivity: "sensitive" },
    });
    expect(within(preview).getByText("•••• 2345")).toBeTruthy();
    expect(within(preview).getByText(/Not written · too long/)).toBeTruthy();
    expect(postMock.mock.calls.some(([path]) => path.endsWith("/apply"))).toBe(false);
    await expectNoA11yViolations(dialog);

    fireEvent.click(within(dialog).getByRole("button", { name: "Write to 2 people" }));
    expect(await within(dialog).findByText("Written for 2 people.")).toBeTruthy();
    const [, applied] = postMock.mock.calls.find(([path]) => path.endsWith("/apply"))!;
    expect(applied?.body).toMatchObject({ position: 3, preview_token: "a".repeat(64) });
  });

  test("any change after a preview discards it, so the confirm always matches what was shown", async () => {
    await renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: "Map column Civil ID" }));
    const dialog = await screen.findByRole("dialog", { name: "Map “Civil ID”" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Preview" }));
    await within(dialog).findByRole("table");

    fireEvent.click(
      within(dialog).getByRole("checkbox", { name: "Replace answers people already have" }),
    );
    expect(within(dialog).queryByRole("table")).toBeNull();
    expect(
      (within(dialog).getByRole("button", { name: "Write to 0 people" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  test("an existing field offers only fields that take values", async () => {
    await renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: "Map column Bus stop" }));
    const dialog = await screen.findByRole("dialog", { name: "Map “Bus stop”" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Use an existing record field" }));
    fireEvent.click(await within(dialog).findByRole("combobox", { name: /^Record field/ }));
    expect(within(dialog).getByRole("option", { name: "Bus stop" })).toBeTruthy();
    expect(within(dialog).queryByRole("option", { name: /Passport scan/ })).toBeNull();
    fireEvent.click(within(dialog).getByRole("option", { name: "Bus stop" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(postMock).toHaveBeenCalled());
    expect(postMock.mock.calls[0]![1]?.body).toMatchObject({ position: 4, field_id: "f-bus" });
  });
});
