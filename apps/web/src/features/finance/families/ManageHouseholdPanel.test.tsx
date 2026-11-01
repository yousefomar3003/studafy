import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";

import { callTo, renderFinance } from "../test-utils";

import type { FinanceFamilyProfile } from "./queries";

const FAMILY = {
  id: "family-1",
  display_name: "Haddad family",
  guardians: [
    { user_id: "parent-1", name: "Rana Haddad", email: "rana@example.edu", is_primary: true },
    { user_id: "parent-2", name: "Sami Haddad", email: "sami@example.edu", is_primary: false },
  ],
  children: [
    {
      student_id: "student-1",
      name: "Lina Haddad",
      admission_number: "ADM-1",
      status: "enrolled",
      child_position: 1,
      sibling_discount_percentage: null,
    },
  ],
} as unknown as FinanceFamilyProfile;

let links = [
  {
    family_id: "family-1",
    parent_user_id: "parent-1",
    student_id: "student-1",
    relationship: "mother",
    created_at: "",
    updated_at: "",
  },
];

const getMock = mock((path: string, _init?: unknown) => {
  if (path === "/api/families/{familyId}") {
    return Promise.resolve({ data: { id: "family-1", display_name: "Haddad family", links } });
  }
  if (path === "/api/families") {
    return Promise.resolve({
      data: { families: [{ id: "family-2", display_name: "Saleh family" }], total: 1 },
    });
  }
  return Promise.resolve({ data: undefined });
});
const patchMock = mock((_path: string, _init?: unknown) => Promise.resolve({ data: {} }));
const deleteMock = mock((_path: string, _init?: unknown) => Promise.resolve({ data: undefined }));

mock.module("../../../lib/api", () => ({
  api: { GET: getMock, PATCH: patchMock, DELETE: deleteMock },
}));

afterEach(() => {
  cleanup();
  getMock.mockClear();
  patchMock.mockClear();
  deleteMock.mockClear();
  links = [
    {
      family_id: "family-1",
      parent_user_id: "parent-1",
      student_id: "student-1",
      relationship: "mother",
      created_at: "",
      updated_at: "",
    },
  ];
});

const load = async () => (await import("./ManageHouseholdPanel")).ManageHouseholdPanel;

describe("ManageHouseholdPanel", () => {
  test("renames the family and changes its primary guardian in one save", async () => {
    const Panel = await load();
    await renderFinance(<Panel family={FAMILY} canUnlink />, { roles: ["ORG_ADMIN"] });

    fireEvent.change(screen.getByLabelText(/Family name/), {
      target: { value: "Al-Haddad family" },
    });
    fireEvent.click(screen.getByRole("combobox", { name: "Primary guardian" }));
    fireEvent.click(await screen.findByRole("option", { name: "Sami Haddad" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));
    expect(callTo(patchMock.mock.calls, "/api/families/{familyId}")).toEqual({
      params: { path: { familyId: "family-1" } },
      body: { display_name: "Al-Haddad family", primary_parent_user_id: "parent-2" },
    });
  });

  test("moves a guardian link to another household, or removes it", async () => {
    const Panel = await load();
    await renderFinance(<Panel family={FAMILY} canUnlink />, { roles: ["ORG_ADMIN"] });

    expect(await screen.findByText("Rana Haddad → Lina Haddad")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Saleh" } });
    fireEvent.click(await screen.findByRole("button", { name: "Saleh family" }));

    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));
    expect(
      callTo(patchMock.mock.calls, "/api/families/{familyId}/links/{parentUserId}/{studentId}"),
    ).toEqual({
      params: { path: { familyId: "family-1", parentUserId: "parent-1", studentId: "student-1" } },
      body: { target_family_id: "family-2" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledTimes(1));
  });

  test("without parent:unlink there is no remove; an empty family can be deleted", async () => {
    links = [];
    const Panel = await load();
    await renderFinance(<Panel family={FAMILY} canUnlink={false} />, { roles: ["ORG_ADMIN"] });

    fireEvent.click(await screen.findByRole("button", { name: "Delete family" }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledTimes(1));
    expect(deleteMock.mock.calls[0]![0]).toBe("/api/families/{familyId}");
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
  });
});
