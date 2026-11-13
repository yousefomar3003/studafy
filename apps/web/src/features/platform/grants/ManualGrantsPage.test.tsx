import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import type { ComponentType, ReactNode } from "react";

/**
 * Manual grants in the console (000211): the cross-school list with its filter, revoking with a
 * reason, and granting storage from a school's card.
 */

const SCHOOL_ID = "11111111-1111-4111-8111-111111111111";
const GIB = 1024 ** 3;

function grant(overrides: Record<string, unknown> = {}) {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    schoolId: SCHOOL_ID,
    schoolName: "Alpha Academy",
    kind: "storage",
    state: "active",
    capBytes: 100 * GIB,
    userId: null,
    userName: null,
    userEmail: null,
    planCode: null,
    planName: null,
    startsAt: "2026-11-13T00:00:00.000Z",
    endsAt: "2027-11-13T00:00:00.000Z",
    reason: "Paid in cash",
    amountMinor: 10000,
    currencyCode: "USD",
    minorUnit: 2,
    hasReceipt: false,
    grantedByUserId: "33333333-3333-4333-8333-333333333333",
    revokedAt: null,
    revokeReason: null,
    createdAt: "2026-11-13T00:00:00.000Z",
    ...overrides,
  };
}

const getMock = mock((path: string, _init?: { params?: { query?: Record<string, string> } }) => {
  if (path === "/api/platform/grants" || path === "/api/platform/schools/{schoolId}/grants") {
    return Promise.resolve({
      data: {
        grants: [
          grant(),
          grant({
            id: "44444444-4444-4444-8444-444444444444",
            kind: "tier",
            capBytes: null,
            userId: "55555555-5555-4555-8555-555555555555",
            userName: "Sara Student",
            planCode: "student_plus",
            planName: "Student Plus",
            amountMinor: null,
            currencyCode: null,
          }),
        ],
      },
    });
  }
  throw new Error(`Unhandled GET ${path}`);
});

const postMock = mock((path: string, init: { body: Record<string, unknown> }) =>
  Promise.resolve({
    data:
      path === "/api/platform/schools/{schoolId}/grants/{grantId}/revoke"
        ? grant({ state: "revoked", revokeReason: init.body.reason })
        : grant(),
  }),
);

mock.module("../../../lib/api", () => ({ api: { GET: getMock, POST: postMock } }));

function wrap(children: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter>{children}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
  postMock.mockClear();
});

describe("ManualGrantsPage", () => {
  test("lists active grants across schools and revokes one with a reason", async () => {
    const Page: ComponentType = (await import("./ManualGrantsPage")).default;
    wrap(<Page />);

    expect(await screen.findByText("Storage: 100 GB")).toBeTruthy();
    expect(screen.getByText("Student Plus")).toBeTruthy();
    expect(screen.getByText("Sara Student")).toBeTruthy();
    expect(getMock.mock.calls[0]?.[1]?.params?.query).toEqual({ filter: "active" });

    const rows = within(screen.getByRole("table")).getAllByRole("row");
    fireEvent.click(within(rows[1]!).getByRole("button", { name: "Revoke" }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Revoke" });
    expect(confirm.hasAttribute("disabled")).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(/Reason/), {
      target: { value: "Entered twice" },
    });
    fireEvent.click(confirm);

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postMock.mock.calls[0]?.[0]).toBe(
      "/api/platform/schools/{schoolId}/grants/{grantId}/revoke",
    );
    expect(postMock.mock.calls[0]?.[1]?.body).toEqual({ reason: "Entered twice" });
  });
});

describe("SchoolGrantsCard", () => {
  test("grants 1 TB of storage for 6 months with the cash amount", async () => {
    const { SchoolGrantsCard } = await import("./SchoolGrantsCard");
    wrap(<SchoolGrantsCard schoolId={SCHOOL_ID} schoolName="Alpha Academy" />);

    fireEvent.click(await screen.findByRole("button", { name: "Grant storage" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("combobox", { name: /Storage/ }));
    fireEvent.click(await screen.findByRole("option", { name: "1 TB" }));
    fireEvent.change(within(dialog).getByLabelText(/Months/), { target: { value: "6" } });
    fireEvent.change(within(dialog).getByLabelText(/^Reason/), {
      target: { value: "Paid 49 USD cash" },
    });
    fireEvent.change(within(dialog).getByLabelText(/Amount paid/), { target: { value: "49" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Grant" }));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    const [path, init] = postMock.mock.calls[0]!;
    expect(path).toBe("/api/platform/schools/{schoolId}/grants");
    expect(init.body).toMatchObject({
      kind: "storage",
      capBytes: 1024 * GIB,
      reason: "Paid 49 USD cash",
      amountMinor: 4900,
      currencyCode: "USD",
    });
    const months =
      (Date.parse(init.body.endsAt as string) - Date.now()) / (1000 * 60 * 60 * 24 * 30);
    expect(Math.round(months)).toBe(6);
  });
});
