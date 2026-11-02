import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { AuthProvider } from "../../lib/auth";
import { expectNoA11yViolations } from "../../lib/test/axe";
import { createTestSessionStore } from "../../lib/test/session";

import type { ComponentType, ReactNode } from "react";

/**
 * The Lists area: the index (leadership creates lists; everyone else only reads the ones shared
 * with them), and one list's table -- masked sensitive cells, the audited reveal for leadership
 * only, the search / filter / sort parameters it sends, and a row edited with a date column read
 * as its calendar day. Every view is audited with axe inside a `<main>`, as RootLayout renders it.
 */

interface RequestInit {
  params?: { path?: Record<string, string>; query?: Record<string, unknown> };
  body?: Record<string, unknown>;
}

const LIST_ID = "11111111-1111-4111-8111-111111111111";

const summary = {
  id: LIST_ID,
  name_en: "Lockers",
  name_ar: "الخزائن",
  description: "Who has which locker.",
  audience: "leadership",
  links: { student: true, parent: false, staff: false, class: false },
  archived: false,
  row_count: 1,
  column_count: 3,
  can_manage: true,
  created_at: "2026-10-01T08:00:00.000Z",
  updated_at: "2026-10-01T08:00:00.000Z",
};

const column = (overrides: Record<string, unknown>) => ({
  required: false,
  sensitivity: "standard",
  sort_order: 0,
  archived: false,
  options: [],
  ...overrides,
});

const LOCKER = column({
  id: "col-locker",
  field_type: "short_text",
  label_en: "Locker",
  label_ar: "الخزانة",
});
const ISSUED = column({
  id: "col-issued",
  field_type: "date",
  label_en: "Issued on",
  label_ar: "تاريخ التسليم",
  sort_order: 1,
});
const CODE = column({
  id: "col-code",
  field_type: "short_text",
  label_en: "Combination",
  label_ar: "الرمز",
  sensitivity: "sensitive",
  sort_order: 2,
});

const detail = { ...summary, columns: [LOCKER, ISSUED, CODE] };

const row = {
  id: "row-1",
  link: { kind: "student", id: "student-1", name: "Amara Chen" },
  cells: [
    { column_id: "col-locker", value: "B-12", masked: false, mask: null },
    // A date can arrive as a midnight-UTC timestamp: only the calendar day is shown and edited.
    { column_id: "col-issued", value: "2026-09-01T00:00:00.000Z", masked: false, mask: null },
    { column_id: "col-code", value: null, masked: true, mask: "••••" },
  ],
  created_at: "2026-10-01T08:00:00.000Z",
  updated_at: "2026-10-01T08:00:00.000Z",
};

const getMock = mock((path: string, _init?: RequestInit) => {
  switch (path) {
    case "/api/custom-lists":
      return Promise.resolve<unknown>({
        data: {
          lists: [summary],
          limits: { lists: 50, columns_per_list: 30, rows_per_list: 5000, rows_per_school: 20000 },
        },
      });
    case "/api/custom-lists/{listId}":
      return Promise.resolve<unknown>({ data: detail });
    case "/api/custom-lists/{listId}/rows":
      return Promise.resolve<unknown>({ data: { rows: [row], total: 1, limit: 25, offset: 0 } });
    case "/api/custom-lists/{listId}/link-candidates":
      return Promise.resolve<unknown>({
        data: { candidates: [{ id: "student-2", name: "Bilal Omari", detail: "ADM-0042" }] },
      });
    default:
      return Promise.resolve<unknown>({ data: undefined });
  }
});

const postMock = mock((path: string, _init?: RequestInit) => {
  if (path === "/api/custom-lists/{listId}/rows/{rowId}/cells/{columnId}/reveal") {
    return Promise.resolve<unknown>({ data: { column_id: "col-code", value: "4-17-33" } });
  }
  return Promise.resolve<unknown>({ data: {} });
});
const patchMock = mock((_path: string, _init?: RequestInit) =>
  Promise.resolve<unknown>({ data: row }),
);

mock.module("../../lib/api", () => ({
  api: { GET: getMock, POST: postMock, PATCH: patchMock, DELETE: mock(() => Promise.resolve({})) },
}));

async function renderAt(roles: string[], url: string, route: string, element: ReactNode) {
  const store = await createTestSessionStore(roles);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <AuthProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <MemoryRouter initialEntries={[url]}>
            <main>
              <Routes>
                <Route path={route} element={element} />
              </Routes>
            </main>
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>
    </AuthProvider>,
  );
}

const loadIndex = async () => (await import("./CustomListsPage")).default as ComponentType;
const loadList = async () => (await import("./CustomListPage")).default as ComponentType;

afterEach(() => {
  cleanup();
  getMock.mockClear();
  postMock.mockClear();
  patchMock.mockClear();
});

function rowsQueries(): Record<string, unknown>[] {
  return getMock.mock.calls
    .filter(([path]) => path === "/api/custom-lists/{listId}/rows")
    .map(([, init]) => (init as RequestInit).params?.query ?? {});
}

describe("the lists index", () => {
  test("leadership sees the lists with New list and the spreadsheet import", async () => {
    const Page = await loadIndex();
    const { container } = await renderAt(["PRINCIPAL"], "/portal/lists", "/portal/lists", <Page />);
    const link = await screen.findByRole("link", { name: "Lockers" });
    expect(link.getAttribute("href")).toBe(`/portal/lists/${LIST_ID}`);
    expect(screen.getByText("School leadership")).toBeTruthy();
    expect(screen.getByText("1 row")).toBeTruthy();
    expect(screen.getByRole("button", { name: "New list" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Create from a spreadsheet" })).toBeTruthy();
    await expectNoA11yViolations(container);
  });

  test("other staff only read the lists shared with them", async () => {
    const Page = await loadIndex();
    await renderAt(["FINANCE"], "/portal/lists", "/portal/lists", <Page />);
    expect(await screen.findByRole("link", { name: "Lockers" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New list" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Create from a spreadsheet" })).toBeNull();
  });

  test("the archived toggle asks for archived lists too", async () => {
    const Page = await loadIndex();
    await renderAt(["ORG_ADMIN"], "/portal/lists", "/portal/lists", <Page />);
    await screen.findByRole("link", { name: "Lockers" });
    fireEvent.click(screen.getByLabelText("Show archived lists"));
    await waitFor(() =>
      expect(
        getMock.mock.calls.some(
          ([path, init]) =>
            path === "/api/custom-lists" &&
            (init as RequestInit).params?.query?.include_archived === "true",
        ),
      ).toBe(true),
    );
  });
});

describe("one list's table", () => {
  test("leadership sees a masked cell, reveals it, and searches, filters and sorts", async () => {
    const Page = await loadList();
    const { container } = await renderAt(
      ["PRINCIPAL"],
      `/portal/lists/${LIST_ID}`,
      "/portal/lists/:listId",
      <Page />,
    );
    expect(await screen.findByRole("heading", { name: /Lockers/ })).toBeTruthy();
    expect(await screen.findByText("B-12")).toBeTruthy();
    expect(screen.getByText("2026-09-01")).toBeTruthy();
    expect(screen.getByText("Amara Chen")).toBeTruthy();
    expect(screen.getByText("••••")).toBeTruthy();
    expect(screen.queryByText("4-17-33")).toBeNull();
    await expectNoA11yViolations(container);

    fireEvent.click(screen.getByRole("button", { name: "Reveal Combination" }));
    expect(await screen.findByText("4-17-33")).toBeTruthy();
    const [path, init] = postMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/custom-lists/{listId}/rows/{rowId}/cells/{columnId}/reveal");
    expect(init.params?.path).toEqual({ listId: LIST_ID, rowId: "row-1", columnId: "col-code" });

    fireEvent.change(screen.getByLabelText("Search rows"), { target: { value: "B-1" } });
    await waitFor(() => expect(rowsQueries().some((query) => query.q === "B-1")).toBe(true));

    // A sensitive column has no sort control; a standard one sorts, then reverses.
    expect(screen.queryByRole("button", { name: /^Combination/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Locker/ }));
    await waitFor(() =>
      expect(
        rowsQueries().some((query) => query.sort === "col-locker" && query.order === "asc"),
      ).toBe(true),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Locker/ }));
    await waitFor(() =>
      expect(
        rowsQueries().some((query) => query.sort === "col-locker" && query.order === "desc"),
      ).toBe(true),
    );

    const filter = screen.getByRole("form", { name: "Filter rows" });
    fireEvent.click(within(filter).getByRole("combobox", { name: "Filter by column" }));
    // Only non-sensitive columns can be filtered on.
    expect(screen.queryByRole("option", { name: "Combination" })).toBeNull();
    fireEvent.click(await screen.findByRole("option", { name: "Locker" }));
    fireEvent.change(within(filter).getByLabelText("Value"), { target: { value: "B" } });
    fireEvent.click(within(filter).getByText("Apply filter").closest("button")!);
    await waitFor(() =>
      expect(
        rowsQueries().some(
          (query) => query.filter_column === "col-locker" && query.filter_value === "B",
        ),
      ).toBe(true),
    );
  }, 30_000);

  test("a member of staff without the sensitive permission gets no Reveal or management", async () => {
    const Page = await loadList();
    await renderAt(["FINANCE"], `/portal/lists/${LIST_ID}`, "/portal/lists/:listId", <Page />);
    expect(await screen.findByText("B-12")).toBeTruthy();
    expect(screen.getByText("••••")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Reveal/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Columns" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
    expect(screen.getByRole("button", { name: "Add row" })).toBeTruthy();
  });

  test("editing a row shows the date as its calendar day and sends only what changed", async () => {
    const Page = await loadList();
    await renderAt(["ORG_ADMIN"], `/portal/lists/${LIST_ID}`, "/portal/lists/:listId", <Page />);
    await screen.findByText("B-12");
    fireEvent.click(screen.getByText("Edit").closest("button")!);

    const dialog = await screen.findByRole("dialog", { name: "Edit a row of Lockers" });
    const date = within(dialog).getByLabelText("Issued on") as HTMLInputElement;
    expect(date.value).toBe("2026-09-01");
    // The sensitive cell is never shown; blank keeps it.
    expect(within(dialog).getByText(/Leave blank to keep the current value/)).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText("Locker"), { target: { value: "C-3" } });
    fireEvent.click(within(dialog).getByText("Save row").closest("button")!);
    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));
    const [path, init] = patchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/custom-lists/{listId}/rows/{rowId}");
    expect(init.body).toEqual({ values: [{ column_id: "col-locker", value: "C-3" }] });
  }, 30_000);

  test("adding a row links it through the list's own picker, which offers only allowed kinds", async () => {
    const Page = await loadList();
    await renderAt(["ORG_ADMIN"], `/portal/lists/${LIST_ID}`, "/portal/lists/:listId", <Page />);
    await screen.findByText("B-12");
    fireEvent.click(screen.getByText("Add row").closest("button")!);

    const dialog = await screen.findByRole("dialog", { name: "Add a row to Lockers" });
    fireEvent.change(within(dialog).getByLabelText("Find a Student"), {
      target: { value: "Bil" },
    });
    const candidate = await within(dialog).findByText("Bilal Omari · ADM-0042");
    const [, init] = getMock.mock.calls.find(
      ([path]) => path === "/api/custom-lists/{listId}/link-candidates",
    ) as [string, RequestInit];
    expect(init.params).toEqual({
      path: { listId: LIST_ID },
      query: { kind: "student", q: "Bil" },
    });
    await expectNoA11yViolations(dialog);

    fireEvent.click(candidate.closest("button")!);
    expect(within(dialog).getByText(/Bilal Omari/)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Locker"), { target: { value: "D-1" } });
    fireEvent.click(within(dialog).getByText("Save row").closest("button")!);
    await waitFor(() =>
      expect(postMock.mock.calls.some(([path]) => path === "/api/custom-lists/{listId}/rows")).toBe(
        true,
      ),
    );
    const [, body] = postMock.mock.calls.find(
      ([path]) => path === "/api/custom-lists/{listId}/rows",
    ) as [string, RequestInit];
    expect(body.body).toMatchObject({
      link: { kind: "student", id: "student-2" },
      values: [{ column_id: "col-locker", value: "D-1" }],
    });
  }, 30_000);
});
