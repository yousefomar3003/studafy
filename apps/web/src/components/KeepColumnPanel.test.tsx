import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";

import { expectNoA11yViolations } from "../lib/test/axe";

import type { ImportSpec } from "../lib/data-transfer";
import type { ComponentType } from "react";

/**
 * "Keep as a record field" in the CSV import dialog: after a staff import, each column the import
 * did not know is offered; the panel previews what would be written for the rows the import created
 * (and only those), discards the preview on any edit, and writes only on confirm, sending the
 * preview's token back.
 */

interface RequestInit {
  params?: { path?: Record<string, string> };
  body?: Record<string, unknown>;
}

const previewResponse = {
  subject_kind: "staff",
  header: "Start date",
  field: {
    id: null,
    field_type: "date",
    label_en: "Start date",
    label_ar: "Start date",
    options: [],
    sensitivity: "standard",
    visibility: "staff_only",
  },
  suggested_sensitive: false,
  sensitive_reason: null,
  totals: { write: 1, unchanged: 0, kept: 0, invalid: 0, empty: 0, conflict: 0, skipped: 0 },
  rows: [
    {
      line_number: 2,
      subject_id: "user-amal",
      name: "Amal",
      status: "write",
      replaces_existing: false,
      // A date answer can arrive as a midnight-UTC timestamp: the panel shows the calendar day.
      value: "2026-09-01T00:00:00.000Z",
      mask: null,
      current_value: null,
      current_mask: null,
      reason: null,
    },
  ],
  preview_token: "a".repeat(64),
};

const postMock = mock((path: string, _init?: RequestInit) => {
  if (path === "/api/record-imports/{subjectKind}/preview") {
    return Promise.resolve<unknown>({ data: previewResponse });
  }
  if (path === "/api/record-imports/{subjectKind}/apply") {
    return Promise.resolve<unknown>({
      data: {
        subject_kind: "staff",
        field_id: "field-start",
        field_created: true,
        written: 1,
        totals: previewResponse.totals,
      },
    });
  }
  return Promise.resolve<unknown>({ data: {} });
});
const getMock = mock(() => Promise.resolve<unknown>({ data: { fields: [] } }));

mock.module("../lib/api", () => ({ api: { GET: getMock, POST: postMock } }));

interface Row {
  name: string;
}

const spec: ImportSpec<Row> = {
  templateName: "users",
  fields: [{ key: "name", label: "Name", required: true }],
  toRecord: (values) => ({ name: String(values.name) }),
  create: async (row) => ({ id: `user-${row.name.toLowerCase()}` }),
  recordColumns: {
    subjectKind: "staff",
    idOf: (created) => (created as { id: string }).id,
    canKeep: true,
    canCreateField: true,
  },
};

const loadButton = async () =>
  (await import("./ImportCsvButton")).ImportCsvButton as ComponentType<{
    spec: ImportSpec<Row>;
    title: string;
    onImported: () => void;
  }>;

async function importFile(csv: string) {
  const ImportCsvButton = await loadButton();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <main>
          <ImportCsvButton spec={spec} title="Import users" onImported={() => undefined} />
        </main>
      </ToastProvider>
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Import file" }));
  const dialog = await screen.findByRole("dialog", { name: "Import users" });
  const input = dialog.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, {
    target: { files: [new File([csv], "staff.csv", { type: "text/csv" })] },
  });
  fireEvent.click(await within(dialog).findByRole("button", { name: "Import 2 rows" }));
  return dialog;
}

afterEach(() => {
  cleanup();
  postMock.mockClear();
  getMock.mockClear();
});

describe("keeping an imported column as a record field", () => {
  test("previews for the created rows only, discards the preview on edit, writes on confirm", async () => {
    const dialog = await importFile("name,Start date,Notes\nAmal,2026-09-01,\nBadr,,\n");

    // Only a column with a value on a created row is offered; Notes is empty everywhere.
    const section = await within(dialog).findByRole("region", {
      name: "Columns this import did not use",
    });
    expect(within(section).queryByRole("button", { name: /Notes/ })).toBeNull();
    fireEvent.click(
      within(section).getByRole("button", {
        name: "Keep the column Start date as a record field",
      }),
    );

    expect(await within(dialog).findByText(/1 row this import created has a value/)).toBeTruthy();
    expect(postMock).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Preview" }));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    const [previewPath, previewInit] = postMock.mock.calls[0] as [string, RequestInit];
    expect(previewPath).toBe("/api/record-imports/{subjectKind}/preview");
    expect(previewInit.params?.path).toEqual({ subjectKind: "staff" });
    expect(previewInit.body).toMatchObject({
      header: "Start date",
      rows: [{ line: 2, subject_id: "user-amal", value: "2026-09-01" }],
      new_field: { label_en: "Start date", label_ar: "Start date", visibility: "staff_only" },
    });
    expect((previewInit.body!.new_field as Record<string, unknown>).field_type).toBeUndefined();

    const table = await within(dialog).findByRole("table", { name: "What would be written" });
    expect(within(table).getByText("2026-09-01")).toBeTruthy();
    expect(within(dialog).getByText("Guessed from the values: Date.")).toBeTruthy();
    await expectNoA11yViolations(dialog.querySelector("form.data-transfer__keep")!);

    // Any edit discards the preview: nothing can be confirmed that was not previewed.
    fireEvent.change(within(dialog).getByLabelText("Field label (English)"), {
      target: { value: "Start date (contract)" },
    });
    expect(within(dialog).queryByText("Write 1 value")).toBeNull();

    fireEvent.click(within(dialog).getByText("Preview").closest("button")!);
    fireEvent.click((await within(dialog).findByText("Write 1 value")).closest("button")!);
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(3));
    const [applyPath, applyInit] = postMock.mock.calls[2] as [string, RequestInit];
    expect(applyPath).toBe("/api/record-imports/{subjectKind}/apply");
    expect(applyInit.body).toMatchObject({
      header: "Start date",
      new_field: { label_en: "Start date (contract)" },
      preview_token: previewResponse.preview_token,
      rows: [{ line: 2, subject_id: "user-amal", value: "2026-09-01" }],
    });
    expect(await within(dialog).findByText("Kept “Start date”: 1 value written.")).toBeTruthy();
  }, 30_000);

  test("without record edit rights the unknown columns are only listed as ignored", async () => {
    const ImportCsvButton = await loadButton();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ToastProvider>
          <ImportCsvButton
            spec={{ ...spec, recordColumns: { ...spec.recordColumns!, canKeep: false } }}
            title="Import users"
            onImported={() => undefined}
          />
        </ToastProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Import file" }));
    const dialog = await screen.findByRole("dialog", { name: "Import users" });
    const input = dialog.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["name,Start date\nAmal,2026-09-01\n"], "staff.csv")] },
    });
    expect(
      await within(dialog).findByText(/These columns are not recognised and will be ignored/),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Import 1 row" }));
    await within(dialog).findByText(/1 created/);
    expect(
      within(dialog).queryByRole("region", { name: "Columns this import did not use" }),
    ).toBeNull();
  });
});
