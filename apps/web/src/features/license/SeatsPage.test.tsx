import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";

import { renderAs } from "./test-utils";

import type { ComponentType } from "react";

/**
 * The school's seats page: a tab per audience (parents only with Family+), everyone with their seat
 * and personal subscription, the seats-left counter and the renewal/price explanation; assigning one
 * person, a selection, or a whole grade; seats running out and who was left without one;
 * unassigning; and no controls without license:manage.
 */

const GRADE_ID = "77777777-7777-4777-8777-777777777777";

const people = {
  sara: {
    userId: "11111111-1111-4111-8111-111111111111",
    studentId: "s-1",
    name: "Sara Ali",
    email: "sara@alpha.test",
    eligible: true,
    seatId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    assignedAt: "2026-09-02T00:00:00.000Z",
    hasPersonalSubscription: false,
    personalSubscriptionEndsAt: null,
  },
  omar: {
    userId: "22222222-2222-4222-8222-222222222222",
    studentId: "s-2",
    name: "Omar Saleh",
    email: "omar@alpha.test",
    eligible: true,
    seatId: null,
    assignedAt: null,
    hasPersonalSubscription: true,
    personalSubscriptionEndsAt: "2026-11-20T00:00:00.000Z",
  },
  lina: {
    userId: "33333333-3333-4333-8333-333333333333",
    studentId: "s-3",
    name: "Lina Haddad",
    email: "lina@alpha.test",
    eligible: true,
    seatId: null,
    assignedAt: null,
    hasPersonalSubscription: false,
    personalSubscriptionEndsAt: null,
  },
  noor: {
    userId: "44444444-4444-4444-8444-444444444444",
    studentId: "s-4",
    name: "Noor Aziz",
    email: "noor@alpha.test",
    eligible: false,
    seatId: null,
    assignedAt: null,
    hasPersonalSubscription: false,
    personalSubscriptionEndsAt: null,
  },
};

let familyPlus = false;
let assignResult: unknown = null;

function overview() {
  return {
    license: {
      id: "licence-1",
      status: "active",
      startsAt: "2026-09-01T00:00:00.000Z",
      endsAt: "2027-08-31T00:00:00.000Z",
      includeFamilyPlus: familyPlus,
      currencyCode: "USD",
      activatedAt: "2026-09-01T00:00:00.000Z",
      audiences: [
        {
          audience: "student",
          purchased: 3,
          assigned: 2,
          tier: { id: "t-1", code: "student_plus", displayName: "Student Plus" },
        },
        { audience: "teacher", purchased: 5, assigned: 0, tier: null },
        { audience: "parent", purchased: familyPlus ? 10 : 0, assigned: 0, tier: null },
      ],
    },
    usage: [],
    openChangeRequests: [],
  };
}

interface Init {
  params?: { query?: Record<string, unknown>; path?: Record<string, string> };
}

const getMock = mock((path: string, _init?: Init) => {
  switch (path) {
    case "/api/school/license":
      return Promise.resolve({ data: overview() });
    case "/api/school/license/people":
      return Promise.resolve({
        data: { people: Object.values(people), total: 4, show: "all" },
      });
    case "/api/school/license/invoices":
      return Promise.resolve({ data: { invoices: [], status: "overdue" } });
    case "/api/academics/years":
      return Promise.resolve({
        data: {
          academic_years: [{ id: "y-1", status: "active", starts_on: "2026-09-01", name: "2026" }],
          total: 1,
        },
      });
    case "/api/academics/grade-levels":
      return Promise.resolve({ data: { grade_levels: [{ id: GRADE_ID, name: "Grade 7" }] } });
    case "/api/academics/sections":
      return Promise.resolve({ data: { sections: [], total: 0 } });
    default:
      throw new Error(`Unhandled GET ${path}`);
  }
});
const postMock = mock((path: string, _init?: { body?: Record<string, unknown> }) => {
  if (path === "/api/school/license/seats") return Promise.resolve({ data: assignResult });
  throw new Error(`Unhandled POST ${path}`);
});
const deleteMock = mock((_path: string, init: Init) =>
  Promise.resolve({ data: { seatId: init.params!.path!.seatId, userId: people.sara.userId } }),
);

mock.module("../../lib/api", () => ({
  api: { GET: getMock, POST: postMock, DELETE: deleteMock },
}));

const loadPage = async (): Promise<ComponentType> => (await import("./SeatsPage")).default;

async function renderPage(role = "PRINCIPAL", at = "/portal/license/seats") {
  const Page = await loadPage();
  return renderAs(role, <Page />, { path: "/portal/license/seats", at });
}

function assignBodies() {
  return postMock.mock.calls
    .filter(([path]) => path === "/api/school/license/seats")
    .map(([, init]) => init!.body!);
}

async function rows() {
  return within(await screen.findByRole("region", { name: "Students and their seats" }));
}

afterEach(() => {
  cleanup();
  familyPlus = false;
  assignResult = null;
  getMock.mockClear();
  postMock.mockClear();
  deleteMock.mockClear();
});

describe("SeatsPage", () => {
  test("shows seats left, why personal subscriptions matter, and everyone's seat status", async () => {
    await renderPage();
    expect(await screen.findByText("1 of 3 seats left for Students")).toBeTruthy();
    expect(screen.getByRole("note").textContent).toContain("turns that subscription's renewal off");
    expect(screen.getByRole("note").textContent).toContain("your school pays a reduced price");

    const table = await rows();
    const row = (name: string) => table.getByText(name).closest("tr")!;
    await table.findByText("Sara Ali");
    expect(within(row("Sara Ali")).getByText(/^Seat since/)).toBeTruthy();
    expect(within(row("Lina Haddad")).getByText("No seat")).toBeTruthy();
    expect(within(row("Noor Aziz")).getByText("Can't hold a seat")).toBeTruthy();
    expect(within(row("Omar Saleh")).getByText(/^Until Nov 20, 2026/)).toBeTruthy();
    // Someone who cannot hold a seat gets no Assign button.
    expect(within(row("Noor Aziz")).queryByRole("button")).toBeNull();
  });

  test("lists parents only when Family+ is included", async () => {
    await renderPage();
    const tabs = within(await screen.findByRole("tablist", { name: "Seats by group" }));
    expect(tabs.getByRole("tab", { name: "Students" })).toBeTruthy();
    expect(tabs.getByRole("tab", { name: "Teachers" })).toBeTruthy();
    expect(tabs.queryByRole("tab", { name: "Parents (Family+)" })).toBeNull();
    cleanup();

    familyPlus = true;
    await renderPage();
    expect(await screen.findByRole("tab", { name: "Parents (Family+)" })).toBeTruthy();
  });

  test("assigns one person at once; a personal subscriber is confirmed with the renewal note", async () => {
    assignResult = {
      assigned: [{ seatId: "seat-x", userId: people.lina.userId, name: "Lina Haddad" }],
      notAssigned: [],
      renewalStops: [],
    };
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Assign a seat to Lina Haddad" }));
    await waitFor(() =>
      expect(assignBodies()).toEqual([{ audience: "student", userIds: [people.lina.userId] }]),
    );
    // The outcome panel, named by its headline (the toast says the same).
    expect(await screen.findByRole("status", { name: "1 seat assigned." })).toBeTruthy();

    assignResult = {
      assigned: [{ seatId: "seat-y", userId: people.omar.userId, name: "Omar Saleh" }],
      notAssigned: [],
      renewalStops: [{ overlapId: "o-1", provider: "stripe", action: "cancel", status: "done" }],
    };
    fireEvent.click(screen.getByRole("button", { name: "Assign a seat to Omar Saleh" }));
    const dialog = await screen.findByRole("dialog", { name: "Assign a seat to 1 person?" });
    expect(within(dialog).getByText("Omar Saleh pays for a personal subscription.")).toBeTruthy();
    expect(dialog.textContent).toContain("turns that subscription's renewal off");
    fireEvent.click(within(dialog).getByRole("button", { name: "Assign" }));

    await waitFor(() => expect(assignBodies()).toHaveLength(2));
    expect(assignBodies()[1]).toEqual({ audience: "student", userIds: [people.omar.userId] });
    expect(
      await screen.findByText("Renewal was turned off for 1 personal subscription."),
    ).toBeTruthy();
  });

  test("assigns a selection and lists who did not get a seat when they run out", async () => {
    assignResult = {
      assigned: [{ seatId: "seat-l", userId: people.lina.userId, name: "Lina Haddad" }],
      notAssigned: [{ userId: people.omar.userId, name: "Omar Saleh", reason: "no_seats_left" }],
      renewalStops: [],
    };
    await renderPage();
    const table = await rows();
    await table.findByText("Omar Saleh");
    fireEvent.click(table.getByRole("checkbox", { name: "Select Omar Saleh" }));
    fireEvent.click(table.getByRole("checkbox", { name: "Select Lina Haddad" }));
    // Sara already has a seat: selecting her offers an unassign, not an assign.
    fireEvent.click(table.getByRole("checkbox", { name: "Select Sara Ali" }));

    const bulk = within(screen.getByRole("group", { name: "Bulk actions" }));
    expect(bulk.getByRole("button", { name: "Unassign 1 selected" })).toBeTruthy();
    fireEvent.click(bulk.getByRole("button", { name: "Assign seats to 2 selected" }));

    const dialog = await screen.findByRole("dialog", { name: "Assign seats to 2 people?" });
    expect(
      within(dialog).getByText(
        "You selected 2 people but only 1 seats are left. The rest will be listed without a seat.",
      ),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Assign" }));

    await waitFor(() =>
      expect(assignBodies()).toEqual([
        { audience: "student", userIds: [people.omar.userId, people.lina.userId] },
      ]),
    );
    const outcome = within(
      await screen.findByRole("list", { name: "Seats ran out before 1 person got one:" }),
    );
    expect(outcome.getByText("Omar Saleh")).toBeTruthy();
    expect(screen.getByRole("status", { name: "1 seat assigned." })).toBeTruthy();
  });

  test("assigns everyone eligible in a grade while seats last", async () => {
    assignResult = {
      assigned: [{ seatId: "seat-l", userId: people.lina.userId, name: "Lina Haddad" }],
      notAssigned: [
        { userId: people.omar.userId, name: "Omar Saleh", reason: "no_seats_left" },
        { userId: people.noor.userId, name: "Noor Aziz", reason: "not_eligible" },
      ],
      renewalStops: [],
    };
    await renderPage();
    const filters = within(await screen.findByRole("group", { name: "Find people" }));
    fireEvent.click(filters.getByRole("combobox", { name: "Grade" }));
    fireEvent.click(await screen.findByRole("option", { name: "Grade 7" }));

    await waitFor(() =>
      expect(
        getMock.mock.calls.some(
          ([path, init]) =>
            path === "/api/school/license/people" && init?.params?.query?.gradeLevelId === GRADE_ID,
        ),
      ).toBe(true),
    );

    fireEvent.click(screen.getByRole("button", { name: "Assign everyone eligible in Grade 7" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Assign everyone eligible in Grade 7?",
    });
    expect(dialog.textContent).toContain("1 left for Students");
    fireEvent.click(within(dialog).getByRole("button", { name: "Assign" }));

    await waitFor(() =>
      expect(assignBodies()).toEqual([
        { audience: "student", scope: { kind: "grade", gradeLevelId: GRADE_ID } },
      ]),
    );
    expect(
      await screen.findByRole("list", { name: "Seats ran out before 1 person got one:" }),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("list", { name: "1 person can't hold a seat:" })).getByText(
        "Noor Aziz",
      ),
    ).toBeTruthy();
  });

  test("assigns all eligible across the school when no grade is picked", async () => {
    assignResult = { assigned: [], notAssigned: [], renewalStops: [] };
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Assign all eligible" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Assign every eligible person in Students?",
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Assign" }));
    await waitFor(() =>
      expect(assignBodies()).toEqual([{ audience: "student", scope: { kind: "all" } }]),
    );
  });

  test("unassigns a seat", async () => {
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Unassign Sara Ali" }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledTimes(1));
    expect(deleteMock.mock.calls[0]![0]).toBe("/api/school/license/seats/{seatId}");
    expect(deleteMock.mock.calls[0]![1].params!.path).toEqual({ seatId: people.sara.seatId });
    expect(await screen.findByText("1 seat freed.")).toBeTruthy();
  });

  test("without license:manage the page is read-only", async () => {
    await renderPage("FINANCE");
    const table = await rows();
    await table.findByText("Sara Ali");
    expect(table.queryAllByRole("checkbox")).toHaveLength(0);
    expect(table.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByRole("group", { name: "Bulk actions" })).toBeNull();
    // Statuses and the counter are still there.
    expect(screen.getByText("1 of 3 seats left for Students")).toBeTruthy();
    expect(table.getAllByText("No seat")).toHaveLength(2);
  });
});
