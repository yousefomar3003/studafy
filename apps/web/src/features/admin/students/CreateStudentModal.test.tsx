import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";

import type { CreateStudentModalProps } from "./CreateStudentModal";
import type { ComponentType } from "react";

const PARENT_USER: Record<string, unknown> = {
  id: "parent-1",
  school_id: "school-1",
  email: "morgan@example.edu",
  display_name: "Morgan Lee",
  status: "active",
  roles: ["PARENT"],
  member_codes: [],
  email_verified_at: null,
  last_login_at: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

const FAMILY: Record<string, unknown> = {
  id: "family-1",
  school_id: "school-1",
  display_name: "Lee",
  primary_parent_user_id: "parent-2",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

interface RequestInit {
  params?: { query?: Record<string, unknown> };
  body?: Record<string, unknown>;
}

const FORM: Record<string, unknown> = {
  subject_kind: "student",
  version: 1,
  fields: [
    {
      id: "field-id",
      field_type: "short_text",
      label_en: "National ID",
      label_ar: "رقم الهوية",
      help_en: null,
      help_ar: null,
      required: true,
      options: [],
      sort_order: 0,
      visibility: "staff_only",
      sensitivity: "sensitive",
      has_expiry: false,
    },
    {
      id: "field-bus",
      field_type: "yes_no",
      label_en: "Takes the bus",
      label_ar: "يستخدم الحافلة",
      help_en: null,
      help_ar: null,
      required: false,
      options: [],
      sort_order: 1,
      visibility: "parent",
      sensitivity: "standard",
      has_expiry: false,
    },
    {
      id: "field-birth",
      field_type: "document",
      label_en: "Birth certificate",
      label_ar: "شهادة الميلاد",
      help_en: null,
      help_ar: null,
      required: true,
      options: [],
      sort_order: 2,
      visibility: "staff_only",
      sensitivity: "standard",
      has_expiry: false,
    },
  ],
};

const getMock = mock((path: string, _init?: RequestInit) => {
  if (path === "/api/record-forms/{subjectKind}") {
    return Promise.resolve<unknown>({ data: FORM });
  }
  if (path === "/api/users") {
    return Promise.resolve<unknown>({ data: { users: [PARENT_USER], next_cursor: null } });
  }
  if (path === "/api/families") {
    return Promise.resolve<unknown>({ data: { families: [FAMILY], total: 1 } });
  }
  return Promise.resolve<unknown>({ data: {} });
});

const postMock = mock((_path: string, init?: RequestInit) =>
  Promise.resolve<unknown>({
    data: { id: "student-1", ...init?.body, created_at: "", updated_at: "" },
  }),
);

mock.module("../../../lib/api", () => ({ api: { GET: getMock, POST: postMock } }));

const loadModal = async (): Promise<ComponentType<CreateStudentModalProps>> =>
  (await import("./CreateStudentModal")).CreateStudentModal;

function renderModal(
  Modal: ComponentType<CreateStudentModalProps>,
  canLinkGuardians: boolean,
  canFillRecords = false,
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <Modal
          open
          onClose={() => undefined}
          canLinkGuardians={canLinkGuardians}
          canFillRecords={canFillRecords}
        />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function fillRequiredFields() {
  fireEvent.change(screen.getByLabelText(/First name/), { target: { value: "Amara" } });
  fireEvent.change(screen.getByLabelText(/Last name/), { target: { value: "Chen" } });
  fireEvent.change(screen.getByLabelText(/Admission number/), { target: { value: "ADM-1" } });
}

function postedBody(): Record<string, unknown> {
  const [path, init] = postMock.mock.calls[0] as [string, RequestInit];
  expect(path).toBe("/api/students");
  return init.body!;
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
  postMock.mockClear();
});

describe("CreateStudentModal", () => {
  test("creates a student with the guardians staff picked, in an existing family", async () => {
    renderModal(await loadModal(), true);
    fillRequiredFields();

    const guardians = screen.getByRole("group", { name: "Guardians (optional)" });
    fireEvent.change(within(guardians).getByRole("searchbox", { name: "Search parents" }), {
      target: { value: "Morgan" },
    });
    fireEvent.click(await within(guardians).findByText("Morgan Lee"));

    // Picked: the relationship defaults to "Guardian" and can be changed.
    fireEvent.click(
      within(guardians).getByRole("combobox", { name: "Relationship of Morgan Lee" }),
    );
    fireEvent.click(await screen.findByRole("option", { name: "Mother" }));

    // Their own household by default; staff can choose an existing family instead.
    expect(within(guardians).getByText("Joins their own household")).toBeTruthy();
    fireEvent.click(within(guardians).getByRole("button", { name: "Join an existing family" }));
    fireEvent.change(within(guardians).getByRole("searchbox", { name: "Search families" }), {
      target: { value: "Lee" },
    });
    fireEvent.click(await within(guardians).findByText("Lee"));
    expect(within(guardians).getByText("Joins the Lee household")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Create student" }));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postedBody()).toMatchObject({
      first_name: "Amara",
      last_name: "Chen",
      admission_number: "ADM-1",
      guardians: [{ parent_user_id: "parent-1", relationship: "mother", family_id: "family-1" }],
    });
  });

  test("a picked guardian can be removed again, and none are sent", async () => {
    renderModal(await loadModal(), true);
    fillRequiredFields();

    const guardians = screen.getByRole("group", { name: "Guardians (optional)" });
    fireEvent.change(within(guardians).getByRole("searchbox", { name: "Search parents" }), {
      target: { value: "Morgan" },
    });
    fireEvent.click(await within(guardians).findByText("Morgan Lee"));
    fireEvent.click(within(guardians).getByRole("button", { name: "Remove Morgan Lee" }));

    fireEvent.click(screen.getByRole("button", { name: "Create student" }));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postedBody().guardians).toBeUndefined();
  });

  test("a caller without parent:link sees no guardian section and sends no guardians", async () => {
    renderModal(await loadModal(), false);
    fillRequiredFields();

    expect(screen.queryByRole("group", { name: "Guardians (optional)" })).toBeNull();
    expect(screen.queryByRole("searchbox", { name: "Search parents" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Create student" }));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postedBody().guardians).toBeUndefined();
    expect(getMock).not.toHaveBeenCalled();
  });

  test("creates a student with their record filled in, in the same request", async () => {
    renderModal(await loadModal(), false, true);
    fillRequiredFields();

    fireEvent.click(await screen.findByRole("button", { name: "Records (optional)" }));
    const records = screen.getByRole("group", { name: "Records (optional)" });
    // Documents are uploaded on the Records tab once the student exists.
    expect(within(records).queryByText("Birth certificate")).toBeNull();
    fireEvent.change(within(records).getByLabelText(/National ID/), {
      target: { value: "784-1990-1234567-1" },
    });
    fireEvent.click(within(records).getByRole("combobox", { name: "Takes the bus" }));
    fireEvent.click(await screen.findByRole("option", { name: "Yes" }));

    fireEvent.click(screen.getByRole("button", { name: "Create student" }));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postedBody().records).toEqual([
      { field_id: "field-id", value: "784-1990-1234567-1" },
      { field_id: "field-bus", value: true },
    ]);
  });

  test("a caller without studentRecord:update sees no Records section", async () => {
    renderModal(await loadModal(), false, false);
    fillRequiredFields();

    expect(screen.queryByRole("button", { name: "Records (optional)" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create student" }));
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postedBody().records).toBeUndefined();
    expect(getMock.mock.calls.some(([path]) => path === "/api/record-forms/{subjectKind}")).toBe(
      false,
    );
  });
});
