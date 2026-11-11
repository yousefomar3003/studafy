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
 * Teachers' employment: lists each teacher by their account's name, refuses an end date without a
 * hire date before it, and saves the record. Plus an accessibility pass.
 */

const TEACHER = {
  id: "teacher-1",
  school_id: "school-1",
  user_id: "user-1",
  employee_number: "T-001",
  employment_status: "active",
  hire_date: null,
  termination_date: null,
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z",
};

// A hire date as the API really sends it (a midnight-UTC timestamp for a `format: date` field).
const VETERAN = {
  ...TEACHER,
  id: "teacher-2",
  user_id: "user-2",
  employee_number: "T-002",
  hire_date: "2019-08-15T00:00:00.000Z",
};

const getMock = mock((path: string, _init?: unknown) => {
  switch (path) {
    case "/api/teachers":
      return Promise.resolve<unknown>({
        data: { teachers: [TEACHER, VETERAN], next_cursor: null },
      });
    case "/api/users":
      return Promise.resolve<unknown>({
        data: {
          users: [
            { id: "user-1", display_name: "Rana Aziz", email: "rana@example.test" },
            { id: "user-2", display_name: "Omar Haddad", email: "omar@example.test" },
          ],
          next_cursor: null,
        },
      });
    default:
      return Promise.resolve<unknown>({ data: undefined });
  }
});
const patchMock = mock((_path: string, _init?: unknown) =>
  Promise.resolve<unknown>({ data: { ...TEACHER, hire_date: "2024-09-01" } }),
);
const postMock = mock((_path: string, init: { body: Record<string, unknown> }) =>
  Promise.resolve<unknown>({
    data: { ...TEACHER, user_id: "33333333-3333-4333-8333-333333333333", ...init.body },
  }),
);
mock.module("../../../lib/api", () => ({
  api: { GET: getMock, PATCH: patchMock, POST: postMock },
}));

async function renderPage() {
  const Page: ComponentType = (await import("./TeachersPage")).default;
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
  patchMock.mockClear();
  postMock.mockClear();
});

describe("TeachersPage", () => {
  test("imports teachers from a file, with no email needed", async () => {
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Import file" }));
    const dialog = await screen.findByRole("dialog", { name: "Import teachers" });
    const input = dialog.querySelector('input[type="file"]') as HTMLInputElement;
    const csv = "display_name,employee_number,phone,email\nRana Khaled,EMP-7,٠٥٠١٢٣٤٥٦٧,\n";
    fireEvent.change(input, { target: { files: [new File([csv], "teachers.csv")] } });

    fireEvent.click(await within(dialog).findByRole("button", { name: "Import 1 row" }));
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postMock.mock.calls[0]![0]).toBe("/api/teachers");
    expect(postMock.mock.calls[0]![1].body).toEqual({
      display_name: "Rana Khaled",
      employee_number: "EMP-7",
      phone: "0501234567",
      employment_status: "active",
    });
  });

  test("a teacher's phone is required", async () => {
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Import file" }));
    const dialog = await screen.findByRole("dialog", { name: "Import teachers" });
    const input = dialog.querySelector('input[type="file"]') as HTMLInputElement;
    const csv = "display_name,employee_number,phone\nRana Khaled,EMP-7,\nSami Aziz,EMP-8,call me\n";
    fireEvent.change(input, { target: { files: [new File([csv], "teachers.csv")] } });

    expect(await within(dialog).findByText(/Phone is required/)).toBeTruthy();
    expect(within(dialog).getByText(/Phone must be a phone number/)).toBeTruthy();
    expect(postMock).not.toHaveBeenCalled();
  });

  test("refuses an end date without a hire date, then saves the record", async () => {
    await renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Edit Rana Aziz's employment" }));
    const dialog = await screen.findByRole("dialog", { name: "Rana Aziz: employment" });
    const save = within(dialog).getByRole("button", { name: "Save" }) as HTMLButtonElement;

    fireEvent.change(within(dialog).getByLabelText(/^End date/), {
      target: { value: "2026-06-30" },
    });
    expect(
      within(dialog).getByText("The end date needs a hire date, on or before it."),
    ).toBeTruthy();
    expect(save.disabled).toBe(true);

    fireEvent.change(within(dialog).getByLabelText(/^Hire date/), {
      target: { value: "2024-09-01" },
    });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);

    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith("/api/teachers/{teacherId}", {
        params: { path: { teacherId: "teacher-1" } },
        body: {
          employee_number: "T-001",
          employment_status: "active",
          hire_date: "2024-09-01",
          termination_date: "2026-06-30",
        },
      }),
    );
    expect(await screen.findByText("Saved Rana Aziz's employment record")).toBeTruthy();
  });

  test("shows and prefills a hire date sent as a timestamp", async () => {
    await renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Edit Omar Haddad's employment" }));
    const dialog = await screen.findByRole("dialog", { name: "Omar Haddad: employment" });
    expect((within(dialog).getByLabelText(/^Hire date/) as HTMLInputElement).value).toBe(
      "2019-08-15",
    );
  });

  test("has no accessibility violations", async () => {
    const { container } = await renderPage();
    await screen.findByText("Rana Aziz");
    await expectNoA11yViolations(container);
  });
});
