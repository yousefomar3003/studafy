import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { AuthProvider } from "../lib/auth";
import { expectNoA11yViolations } from "../lib/test/axe";
import { createTestSessionStore } from "../lib/test/session";

import type { ImportSpec } from "../lib/data-transfer";
import type { ComponentType } from "react";

/**
 * A sheet none of whose columns the import knows is offered as a custom list -- to leadership
 * only -- and handed to the list import in memory; a sheet the import recognises is not.
 */

mock.module("../lib/api", () => ({ api: { GET: mock(), POST: mock() } }));

interface Row {
  name: string;
}

const spec: ImportSpec<Row> = {
  templateName: "classes",
  fields: [{ key: "name", label: "Name", required: true }],
  toRecord: (values) => ({ name: String(values.name) }),
  create: async () => ({}),
};

const UNKNOWN = "Bus route,Stop,Driver\n4,Garden St,Sami\n";

async function openWith(roles: string[], csv: string) {
  const { ImportCsvButton } = (await import("./ImportCsvButton")) as {
    ImportCsvButton: ComponentType<{
      spec: ImportSpec<Row>;
      title: string;
      onImported: () => void;
    }>;
  };
  const store = await createTestSessionStore(roles);
  const result = render(
    <AuthProvider store={store}>
      <QueryClientProvider client={new QueryClient()}>
        <ToastProvider>
          <MemoryRouter initialEntries={["/portal/principal/classes"]}>
            <main>
              <Routes>
                <Route
                  path="/portal/principal/classes"
                  element={
                    <ImportCsvButton
                      spec={spec}
                      title="Import classes"
                      onImported={() => undefined}
                    />
                  }
                />
                <Route path="/portal/lists/import" element={<p>List import</p>} />
              </Routes>
            </main>
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>
    </AuthProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Import file" }));
  const dialog = await screen.findByRole("dialog", { name: "Import classes" });
  const input = dialog.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File([csv], "buses.csv")] } });
  return { ...result, dialog };
}

afterEach(() => cleanup());

describe("an unrecognised sheet in the CSV import", () => {
  test("leadership is offered a custom list, and the sheet goes to the list import", async () => {
    const { dialog } = await openWith(["PRINCIPAL"], UNKNOWN);
    expect(
      await within(dialog).findByText(/Studafy doesn't recognise any column of this sheet/),
    ).toBeTruthy();
    await expectNoA11yViolations(dialog);

    fireEvent.click(
      within(dialog).getByText("Create a custom list from this sheet").closest("button")!,
    );
    expect(await screen.findByText("List import")).toBeTruthy();
    const { takePendingSheet } = await import("../features/custom-lists/sheet-handoff");
    expect(takePendingSheet()).toEqual({ fileName: "buses.csv", csv: UNKNOWN });
  });

  test("staff without customList:manage only see why the file was refused", async () => {
    const { dialog } = await openWith(["FINANCE"], UNKNOWN);
    expect(await within(dialog).findByText(/missing required columns/)).toBeTruthy();
    expect(within(dialog).queryByText("Create a custom list from this sheet")).toBeNull();
  });

  test("a sheet with a known column is not offered", async () => {
    const { dialog } = await openWith(["PRINCIPAL"], "Name,Room\n10A,12\n");
    expect(await within(dialog).findByText(/Import 1 row/)).toBeTruthy();
    expect(within(dialog).queryByText("Create a custom list from this sheet")).toBeNull();
  });
});
