import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import type { ReactNode } from "react";

/**
 * The console's per-school administration: the usage panel shows accounts, storage, activity and
 * licence seats; the profile editor sends only the changed fields with a reason; an export needs a
 * reason and a download link is fetched only on click; the schools list sends its sort and usage
 * filters to the API.
 */

const SCHOOL_ID = "11111111-1111-4111-8111-111111111111";
const EXPORT_ID = "55555555-5555-4555-8555-555555555555";
const GIB = 1024 ** 3;

const school = {
  id: SCHOOL_ID,
  slug: "alpha-academy",
  name: "Alpha Academy",
  email: "office@alpha.test",
  status: "active",
  schoolNumber: 3,
  countryCode: "AE",
  currencyCode: "AED",
  isReviewTenant: false,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  emailVerifiedAt: null,
  activeUsers: 3,
  students: 2,
  subscription: null,
  storageBytesUsed: 9 * GIB,
  storageCapBytes: 10 * GIB,
  lastActivityAt: "2026-11-01T09:00:00.000Z",
  roleCounts: { STUDENT: 2 },
  featureFlags: [],
  allowedTransitions: ["suspended", "archived"],
  locale: "en",
  timezone: "Asia/Dubai",
};

const usage = {
  people: [
    { role: "PARENT", active: 0, invited: 2 },
    { role: "STUDENT", active: 40, invited: 1 },
  ],
  pendingInvitations: 3,
  storage: { bytesUsed: 9 * GIB, capBytes: 10 * GIB, fractionUsed: 0.9 },
  ai: {
    activeSubscriptions: 5,
    tokensThisPeriod: 12000,
    monthStart: "2026-11-01",
    featureUses: [{ featureKey: "ai_tutor", used: 31 }],
  },
  activity: { lastActivityAt: "2026-11-01T09:00:00.000Z", activeUsersLast30Days: 17 },
  license: {
    id: "66666666-6666-4666-8666-666666666666",
    startsAt: "2026-09-01T00:00:00.000Z",
    endsAt: "2027-08-31T00:00:00.000Z",
    seats: [
      { audience: "student", bought: 50, used: 40 },
      { audience: "teacher", bought: 5, used: 3 },
      { audience: "parent", bought: 0, used: 0 },
    ],
  },
  generatedAt: "2026-11-13T00:00:00.000Z",
};

let exportsList: unknown[] = [];

const getMock = mock((path: string, _init?: unknown) => {
  if (path === "/api/platform/schools/{schoolId}/usage") return Promise.resolve({ data: usage });
  if (path === "/api/platform/schools/{schoolId}/exports") {
    return Promise.resolve({ data: { exports: exportsList } });
  }
  if (path === "/api/platform/schools/{schoolId}/exports/{exportId}") {
    return Promise.resolve({
      data: {
        ...(exportsList[0] as object),
        downloadUrl: "https://files.test/export.zip",
        downloadUrlExpiresAt: "2026-11-13T01:00:00.000Z",
      },
    });
  }
  if (path === "/api/lookups/countries") {
    return Promise.resolve({
      data: {
        countries: [
          { id: "c1", alpha2_code: "AE", name: "United Arab Emirates" },
          { id: "c2", alpha2_code: "JO", name: "Jordan" },
        ],
      },
    });
  }
  if (path === "/api/lookups/currencies") {
    return Promise.resolve({
      data: {
        currencies: [
          { id: "u1", code: "AED", name: "UAE Dirham" },
          { id: "u2", code: "JOD", name: "Jordanian Dinar" },
        ],
      },
    });
  }
  if (path === "/api/platform/schools") {
    return Promise.resolve({ data: { schools: [school], total: 1 } });
  }
  throw new Error(`Unhandled GET ${path}`);
});
const patchMock = mock((_path: string, init: { body: Record<string, unknown> }) =>
  Promise.resolve({ data: { ...school, ...init.body } }),
);
const postMock = mock((_path: string, _init: { body: { reason: string } }) =>
  Promise.resolve({
    data: {
      id: EXPORT_ID,
      status: "queued",
      createdAt: "2026-11-13T00:00:00.000Z",
      completedAt: null,
      failureMessage: null,
      expiresAt: null,
      deletedAt: null,
      downloadUrl: null,
      downloadUrlExpiresAt: null,
    },
  }),
);

mock.module("../../lib/api", () => ({
  api: { GET: getMock, PATCH: patchMock, POST: postMock },
}));

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
  exportsList = [];
  getMock.mockClear();
  patchMock.mockClear();
  postMock.mockClear();
});

describe("SchoolUsageCard", () => {
  test("shows accounts, storage, activity, AI use and licence seats", async () => {
    const { SchoolUsageCard } = await import("./SchoolUsageCard");
    wrap(<SchoolUsageCard schoolId={SCHOOL_ID} />);
    const card = await screen.findByRole("region", { name: "Usage" });
    await within(card).findByText("9 GB of 10 GB used");

    const rows = within(card).getAllByRole("row");
    // Students first, then parents.
    expect(rows[1]!.textContent).toContain("Student");
    expect(rows[1]!.textContent).toContain("40");
    expect(rows[2]!.textContent).toContain("Parent");
    expect(within(card).getByText("3 open invitations")).toBeTruthy();
    expect(within(card).getByText("90% of the cap")).toBeTruthy();
    expect(within(card).getByText("17")).toBeTruthy();
    expect(within(card).getByText("ai_tutor")).toBeTruthy();
    expect(within(card).getByText("40 of 50 seats")).toBeTruthy();
  });
});

describe("EditSchoolProfileDialog", () => {
  test("sends only the changed fields, with the reason", async () => {
    const { EditSchoolProfileDialog } = await import("./EditSchoolProfileDialog");
    const onClose = mock(() => undefined);
    wrap(<EditSchoolProfileDialog school={school as never} open onClose={onClose} />);
    const dialog = await screen.findByRole("dialog");
    const save = within(dialog).getByRole("button", { name: "Save changes" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(within(dialog).getByLabelText(/School name/), {
      target: { value: "Alpha International" },
    });
    fireEvent.change(within(dialog).getByLabelText(/Timezone/), {
      target: { value: "Asia/Amman" },
    });
    // A change without a reason cannot be saved.
    expect(save.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(/^Reason/), {
      target: { value: "Renamed by the owner" },
    });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);

    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));
    expect(patchMock.mock.calls[0]![1].body).toEqual({
      name: "Alpha International",
      timezone: "Asia/Amman",
      reason: "Renamed by the owner",
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});

describe("SchoolExportsCard", () => {
  test("an export needs a reason and is posted with it", async () => {
    const { SchoolExportsCard } = await import("./SchoolExportsCard");
    wrap(<SchoolExportsCard schoolId={SCHOOL_ID} schoolName="Alpha Academy" />);
    await screen.findByText("No exports yet.");

    fireEvent.click(screen.getByRole("button", { name: "Export school data" }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", {
      name: "Start export",
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(/Reason/), {
      target: { value: "Moving to a new server" },
    });
    fireEvent.click(confirm);

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postMock.mock.calls[0]![1].body).toEqual({ reason: "Moving to a new server" });
  });

  test("a ready export fetches its download link only when clicked", async () => {
    exportsList = [
      {
        id: EXPORT_ID,
        status: "completed",
        createdAt: "2026-11-12T00:00:00.000Z",
        completedAt: "2026-11-12T00:10:00.000Z",
        failureMessage: null,
        expiresAt: "2026-12-12T00:10:00.000Z",
        deletedAt: null,
        downloadUrl: null,
        downloadUrlExpiresAt: null,
      },
    ];
    const assign = mock((_url: string) => undefined);
    const original = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...original, assign },
    });
    try {
      const { SchoolExportsCard } = await import("./SchoolExportsCard");
      wrap(<SchoolExportsCard schoolId={SCHOOL_ID} schoolName="Alpha Academy" />);
      const download = await screen.findByRole("button", { name: "Download" });
      expect(
        getMock.mock.calls.some(
          ([path]) => path === "/api/platform/schools/{schoolId}/exports/{exportId}",
        ),
      ).toBe(false);

      fireEvent.click(download);
      await waitFor(() => expect(assign).toHaveBeenCalledWith("https://files.test/export.zip"));
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: original });
    }
  });
});

describe("SchoolsListPage usage columns", () => {
  test("sends the usage sort and filters to the API", async () => {
    const Page = (await import("./SchoolsListPage")).default;
    wrap(<Page />);
    await screen.findByText("Alpha Academy");
    expect(screen.getByText("90%")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Storage" }));
    await waitFor(() =>
      expect(
        getMock.mock.calls.some(([path, init]) => {
          const query = (init as { params: { query: Record<string, unknown> } } | undefined)?.params
            .query;
          return path === "/api/platform/schools" && query?.sort === "storage";
        }),
      ).toBe(true),
    );
  });
});
