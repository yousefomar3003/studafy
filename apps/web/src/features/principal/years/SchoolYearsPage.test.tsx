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
 * School years & terms page: lists the years (current one selected) and its terms, adds a term
 * after the existing ones, and starts a planned year only once the principal confirms they
 * understand what closes. Plus an accessibility pass.
 */

// Dates as the API really sends them: `format: date` fields arrive as midnight-UTC timestamps.
const STAMP = { created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z" };
const CURRENT = {
  id: "year-1",
  school_id: "school-1",
  code: "2026-27",
  name: "2026–2027",
  status: "active",
  starts_on: "2026-09-01T00:00:00.000Z",
  ends_on: "2027-06-30T00:00:00.000Z",
  ...STAMP,
};
const NEXT = {
  ...CURRENT,
  id: "year-2",
  code: "2027-28",
  name: "2027–2028",
  status: "planned",
  starts_on: "2027-09-01T00:00:00.000Z",
  ends_on: "2028-06-30T00:00:00.000Z",
};
const TERM_1 = {
  id: "term-1",
  school_id: "school-1",
  academic_year_id: "year-1",
  code: "T1",
  name: "Term 1",
  sequence_number: 1,
  status: "active",
  starts_on: "2026-09-01T00:00:00.000Z",
  ends_on: "2027-01-31T00:00:00.000Z",
  ...STAMP,
};

const getMock = mock((path: string, _init?: unknown) => {
  switch (path) {
    case "/api/academics/years":
      return Promise.resolve<unknown>({ data: { academic_years: [CURRENT, NEXT], total: 2 } });
    case "/api/academics/years/{yearId}/terms":
      return Promise.resolve<unknown>({ data: { terms: [TERM_1], total: 1 } });
    default:
      return Promise.resolve<unknown>({ data: undefined });
  }
});
const postMock = mock((path: string, _init?: unknown) => {
  if (path === "/api/academics/years/{yearId}/rollover") {
    return Promise.resolve<unknown>({
      data: {
        prior_year_id: "year-1",
        prior_year_status: "closed",
        new_year_id: "year-2",
        new_year_status: "active",
        enrollments_archived: 42,
      },
    });
  }
  return Promise.resolve<unknown>({ data: { ...TERM_1, id: "term-2" } });
});
mock.module("../../../lib/api", () => ({
  api: { GET: getMock, POST: postMock, PATCH: mock(), DELETE: mock() },
}));

async function renderPage() {
  const Page: ComponentType = (await import("./SchoolYearsPage")).default;
  const store = await createTestSessionStore(["PRINCIPAL"]);
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

describe("SchoolYearsPage", () => {
  test("shows the current year's terms and adds the next term", async () => {
    await renderPage();

    expect(await screen.findByRole("heading", { name: "Terms of 2026–2027" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Edit Term 1" })).toBeTruthy();
    // Editing prefills the date inputs with the date part of the API's timestamps.
    fireEvent.click(screen.getByRole("button", { name: "Edit Term 1" }));
    const editDialog = await screen.findByRole("dialog", { name: "Edit term" });
    expect((within(editDialog).getByLabelText(/^Starts on/) as HTMLInputElement).value).toBe(
      "2026-09-01",
    );
    fireEvent.click(within(editDialog).getByRole("button", { name: "Cancel" }));

    // Only a planned year can be started or deleted; the current one offers neither.
    expect(screen.queryByRole("button", { name: "Delete 2026–2027" })).toBeNull();
    expect(screen.getByRole("button", { name: "Delete 2027–2028" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Add term" }));
    const dialog = await screen.findByRole("dialog", { name: "Add term" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: /^Name/ }), {
      target: { value: "Term 2" },
    });
    fireEvent.change(within(dialog).getByRole("textbox", { name: /^Code/ }), {
      target: { value: "T2" },
    });
    fireEvent.change(within(dialog).getByLabelText(/^Starts on/), {
      target: { value: "2027-02-01" },
    });
    fireEvent.change(within(dialog).getByLabelText(/^Ends on/), {
      target: { value: "2027-06-30" },
    });
    // The order defaults to just after the last term.
    expect(
      (within(dialog).getByRole("spinbutton", { name: /^Order in the year/ }) as HTMLInputElement)
        .value,
    ).toBe("2");
    fireEvent.click(within(dialog).getByRole("button", { name: "Add term" }));

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith("/api/academics/years/{yearId}/terms", {
        params: { path: { yearId: "year-1" } },
        body: {
          name: "Term 2",
          code: "T2",
          starts_on: "2027-02-01",
          ends_on: "2027-06-30",
          sequence_number: 2,
          status: "planned",
          academic_year_id: "year-1",
        },
      }),
    );
    await screen.findByText("Term added");
  });

  test("starts a planned year only after the principal confirms what it closes", async () => {
    await renderPage();

    fireEvent.click(
      await screen.findByRole("button", { name: "Start 2027–2028 as the current year" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Start 2027–2028?" });
    expect(within(dialog).getByText(/2026–2027 is closed/)).toBeTruthy();
    const confirm = within(dialog).getByRole("button", { name: "Start the year" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(within(dialog).getByRole("checkbox", { name: "I understand" }));
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith("/api/academics/years/{yearId}/rollover", {
        params: { path: { yearId: "year-2" } },
      }),
    );
    expect(await screen.findByText("2027–2028 is now the current year")).toBeTruthy();
    expect(screen.getByText("42 enrolments marked completed.")).toBeTruthy();
  });

  test("has no accessibility violations", async () => {
    const { container } = await renderPage();
    await screen.findByRole("button", { name: "Edit Term 1" });
    await expectNoA11yViolations(container);
  });
});
