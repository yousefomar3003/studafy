import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";

import type { CreateUserModalProps } from "./CreateUserModal";
import type { ComponentType } from "react";

const STUDENT: Record<string, unknown> = {
  id: "student-1",
  school_id: "school-1",
  user_id: "user-9",
  first_name: "Amara",
  middle_name: null,
  last_name: "Chen",
  preferred_name: null,
  date_of_birth: null,
  nationality_country_id: null,
  admission_number: "ADM-2024-001",
  admission_date: null,
  status: "enrolled",
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z",
};

interface RequestInit {
  params?: { query?: Record<string, unknown> };
  body?: Record<string, unknown>;
}

const PARENT_FORM: Record<string, unknown> = {
  subject_kind: "parent",
  version: 1,
  fields: [
    {
      id: "field-phone",
      field_type: "phone",
      label_en: "Work phone",
      label_ar: "هاتف العمل",
      help_en: null,
      help_ar: null,
      required: false,
      options: [],
      sort_order: 0,
      visibility: "finance",
      sensitivity: "standard",
      has_expiry: false,
    },
  ],
};

const getMock = mock((path: string, _init?: RequestInit) => {
  if (path === "/api/record-forms/{subjectKind}") {
    return Promise.resolve<unknown>({ data: PARENT_FORM });
  }
  if (path === "/api/students") {
    return Promise.resolve<unknown>({ data: { students: [STUDENT], next_cursor: null } });
  }
  return Promise.resolve<unknown>({ data: {} });
});

const postMock = mock((_path: string, init?: RequestInit) =>
  Promise.resolve<unknown>({
    data: {
      id: "parent-1",
      school_id: "school-1",
      email: init?.body?.email,
      display_name: init?.body?.display_name,
      status: "invited",
      roles: [init?.body?.role],
      member_codes: [],
      email_verified_at: null,
      last_login_at: null,
      created_at: "",
      updated_at: "",
    },
  }),
);

mock.module("../../../lib/api", () => ({ api: { GET: getMock, POST: postMock } }));

const loadModal = async (): Promise<ComponentType<CreateUserModalProps>> =>
  (await import("./CreateUserModal")).CreateUserModal;

function renderModal(
  Modal: ComponentType<CreateUserModalProps>,
  canLinkChildren: boolean,
  canFillRecords = false,
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <Modal
          open
          onClose={() => undefined}
          canLinkChildren={canLinkChildren}
          canFillRecords={canFillRecords}
        />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

async function fillAsParent() {
  fireEvent.change(screen.getByLabelText(/Email/), { target: { value: "rana@example.edu" } });
  fireEvent.change(screen.getByLabelText(/Display name/), { target: { value: "Rana Haddad" } });
  fireEvent.click(screen.getByRole("combobox", { name: "Role" }));
  fireEvent.click(await screen.findByRole("option", { name: "Parent" }));
}

function postedBody(): Record<string, unknown> {
  const [path, init] = postMock.mock.calls[0] as [string, RequestInit];
  expect(path).toBe("/api/users");
  return init.body!;
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
  postMock.mockClear();
});

describe("CreateUserModal", () => {
  test("creates a parent already linked to the children staff picked", async () => {
    renderModal(await loadModal(), true);

    // No link step until the PARENT role is chosen.
    expect(screen.queryByRole("group", { name: "Link children (optional)" })).toBeNull();
    await fillAsParent();

    const step = screen.getByRole("group", { name: "Link children (optional)" });
    fireEvent.change(within(step).getByRole("searchbox", { name: "Search students" }), {
      target: { value: "Amara" },
    });
    fireEvent.click(await within(step).findByText("Amara Chen"));
    fireEvent.click(within(step).getByRole("combobox", { name: "Relationship of Amara Chen" }));
    fireEvent.click(await screen.findByRole("option", { name: "Father" }));

    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postedBody()).toEqual({
      email: "rana@example.edu",
      display_name: "Rana Haddad",
      role: "PARENT",
      children: [{ student_id: "student-1", relationship: "father" }],
    });
  });

  test("a parent can still be created without children", async () => {
    renderModal(await loadModal(), true);
    await fillAsParent();

    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postedBody().children).toBeUndefined();
  });

  test("a caller without parent:link sees no link step, even for a parent", async () => {
    renderModal(await loadModal(), false);
    await fillAsParent();

    expect(screen.queryByRole("group", { name: "Link children (optional)" })).toBeNull();
    expect(screen.queryByRole("searchbox", { name: "Search students" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postedBody().children).toBeUndefined();
    expect(getMock).not.toHaveBeenCalled();
  });

  test("a new parent's record is filled in with the account", async () => {
    renderModal(await loadModal(), false, true);
    await fillAsParent();

    fireEvent.click(await screen.findByRole("button", { name: "Records (optional)" }));
    fireEvent.change(screen.getByLabelText(/Work phone/), {
      target: { value: "+971 50 123 4567" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postedBody().records).toEqual([{ field_id: "field-phone", value: "+971 50 123 4567" }]);
  });
});
