import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { AuthProvider } from "../../lib/auth";
import { expectNoA11yViolations } from "../../lib/test/axe";
import { createTestSessionStore } from "../../lib/test/session";

import type { ComponentType } from "react";

/**
 * "Create a list from a spreadsheet": a sheet handed over by an import that did not recognise it
 * is previewed (guessed types, every row's proposed link or why not), any edit discards the
 * preview, and only a confirm sends the preview's token back -- then the new list opens.
 */

interface RequestInit {
  body?: Record<string, unknown>;
}

const CSV = "Admission no,Book,Due\nA-100,Atlas,2026-11-20\nZ-999,Poems,2026-11-21\n";
const TOKEN = "b".repeat(64);
const NEW_LIST = "22222222-2222-4222-8222-222222222222";

function previewResponse(bookType: string) {
  return {
    header_line: 1,
    row_count: 2,
    columns: [
      {
        index: 0,
        header: "Admission no",
        include: true,
        label_en: "Admission no",
        label_ar: "Admission no",
        field_type: "short_text",
        guessed_type: "short_text",
        sensitivity: "standard",
        suggested_sensitive: false,
        options: [],
        sample: ["A-100", "Z-999"],
        invalid_count: 0,
        invalid_lines: [],
      },
      {
        index: 1,
        header: "Book",
        include: true,
        label_en: "Book",
        label_ar: "Book",
        field_type: bookType,
        guessed_type: "short_text",
        sensitivity: "standard",
        suggested_sensitive: false,
        options: [],
        sample: ["Atlas", "Poems"],
        invalid_count: 0,
        invalid_lines: [],
      },
      {
        index: 2,
        header: "Due",
        include: true,
        label_en: "Due",
        label_ar: "Due",
        field_type: "date",
        guessed_type: "date",
        sensitivity: "standard",
        suggested_sensitive: false,
        options: [],
        sample: ["2026-11-20", "2026-11-21"],
        invalid_count: 0,
        invalid_lines: [],
      },
    ],
    rows: [
      {
        line: 2,
        key: "A-100",
        status: "linked",
        reason: null,
        link: { kind: "student", id: "student-1", name: "Amara Chen" },
      },
      { line: 3, key: "Z-999", status: "unmatched", reason: "NO_MATCH", link: null },
    ],
    totals: { rows: 2, linked: 1, unmatched: 1, skipped: 0, invalid_cells: 0 },
    links: { student: true, parent: false, staff: false, class: false },
    preview_token: TOKEN,
  };
}

const postMock = mock((path: string, init?: RequestInit) => {
  if (path === "/api/custom-lists/imports/preview") {
    const columns = init?.body?.columns as { field_type: string }[] | undefined;
    return Promise.resolve<unknown>({
      data: previewResponse(columns?.[1]?.field_type ?? "short_text"),
    });
  }
  if (path === "/api/custom-lists/imports/apply") {
    return Promise.resolve<unknown>({
      data: { list_id: NEW_LIST, rows_created: 2, rows_linked: 1, cells_left_empty: 0 },
    });
  }
  return Promise.resolve<unknown>({ data: {} });
});

mock.module("../../lib/api", () => ({ api: { GET: mock(), POST: postMock } }));

const loadPage = async () => (await import("./CustomListImportPage")).default as ComponentType;

afterEach(() => {
  cleanup();
  postMock.mockClear();
});

describe("creating a list from a sheet", () => {
  test("previews every row's link, discards the preview on edit, creates with the token", async () => {
    const { setPendingSheet } = await import("./sheet-handoff");
    setPendingSheet({ fileName: "library-loans.csv", csv: CSV });
    const Page = await loadPage();
    const store = await createTestSessionStore(["ORG_ADMIN"]);
    const { container } = render(
      <AuthProvider store={store}>
        <QueryClientProvider client={new QueryClient()}>
          <ToastProvider>
            <MemoryRouter initialEntries={["/portal/lists/import"]}>
              <main>
                <Routes>
                  <Route path="/portal/lists/import" element={<Page />} />
                  <Route path="/portal/lists/:listId" element={<p>The new list</p>} />
                </Routes>
              </main>
            </MemoryRouter>
          </ToastProvider>
        </QueryClientProvider>
      </AuthProvider>,
    );

    // The handed-over sheet is already chosen, its name suggested as the list's.
    expect(screen.getByText("File: library-loans.csv")).toBeTruthy();
    expect((screen.getByLabelText(/List name \(English\)/) as HTMLInputElement).value).toBe(
      "library-loans",
    );
    expect(postMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Preview").closest("button")!);
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    const [, first] = postMock.mock.calls[0] as [string, RequestInit];
    expect(first.body).toMatchObject({
      csv: CSV,
      file_name: "library-loans.csv",
      list: { name_en: "library-loans", name_ar: "library-loans", audience: "admins" },
      link: null,
    });

    const rows = await screen.findByRole("table", { name: "Every row and what it links to" });
    expect(within(rows).getByText("Links to Student Amara Chen")).toBeTruthy();
    expect(within(rows).getByText("No match: nothing in the school has this key")).toBeTruthy();
    expect(screen.getByText("2 rows: 1 linked, 1 not linked, 0 left out.")).toBeTruthy();
    expect(screen.getAllByText("Suggested: Short text").length).toBeGreaterThan(0);
    await expectNoA11yViolations(container);

    // Any edit discards the preview: nothing can be created that was not previewed.
    fireEvent.change(screen.getByLabelText("English name for Book"), {
      target: { value: "Book title" },
    });
    expect(screen.queryByText("Create list with 2 rows")).toBeNull();

    fireEvent.click(screen.getByText("Preview again").closest("button")!);
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(2));
    const [, second] = postMock.mock.calls[1] as [string, RequestInit];
    expect((second.body!.columns as { label_en: string }[])[1]!.label_en).toBe("Book title");

    fireEvent.click((await screen.findByText("Create list with 2 rows")).closest("button")!);
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(3));
    const [applyPath, apply] = postMock.mock.calls[2] as [string, RequestInit];
    expect(applyPath).toBe("/api/custom-lists/imports/apply");
    expect(apply.body).toMatchObject({ preview_token: TOKEN, csv: CSV });
    expect((apply.body!.columns as { label_en: string }[])[1]!.label_en).toBe("Book title");
    expect(await screen.findByText("The new list")).toBeTruthy();
  }, 30_000);
});
