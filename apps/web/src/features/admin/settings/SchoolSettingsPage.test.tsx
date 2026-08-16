import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import { AuthProvider, createSessionStore } from "../../../lib/auth";

import type { SessionTokens } from "../../../lib/auth";
import type { ComponentType } from "react";

/**
 * Interaction coverage for the settings hub: each section loads its current value, saves a change
 * through its own `PATCH`, and reflects the response back into the field — the acceptance criterion
 * ("each setting persists and reflects") exercised directly rather than only via e2e. Grading scheme
 * and the discipline-visibility toggle additionally confirm the destructive-change dialog fires.
 */

const USER_ID = "user-1";

let schoolSettings = {
  locale: "en" as const,
  timezone: "Africa/Casablanca",
  grading_scheme: "letter" as const,
  invitation_expiry_days: 7,
  attendance_alert_threshold: 75,
  absence_alert_threshold: 25,
  parent_discipline_visibility: false,
  attendance_correction_window_hours: 48,
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z",
};

let myUser = {
  id: USER_ID,
  school_id: "school-1",
  email: "admin@example.edu",
  display_name: "Jamie Admin",
  status: "active" as const,
  roles: ["ORG_ADMIN"] as const,
  email_verified_at: "2026-08-01T00:00:00.000Z",
  last_login_at: "2026-08-01T00:00:00.000Z",
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z",
};

const SUBSCRIPTION_OVERVIEW = {
  subscription: {
    id: "sub-1",
    status: "active",
    currentPeriodStart: "2026-08-01T00:00:00.000Z",
    currentPeriodEnd: "2026-09-01T00:00:00.000Z",
    cancelAtPeriodEnd: false,
    cancellationRequestedAt: null,
    cancellationReason: null,
    retentionState: "none",
  },
  plan: { id: "plan-1", code: "growth", displayName: "Studafy Growth" },
  seats: { used: 7, cap: 20 },
  storage: { usedBytes: 524_288_000, capBytes: 1_048_576_000, fractionUsed: 0.5 },
};

function getMockImplementation(path: string) {
  if (path === "/api/schools/current/settings") {
    return Promise.resolve<unknown>({ data: schoolSettings });
  }
  if (path === "/api/users/{userId}") {
    return Promise.resolve<unknown>({ data: myUser });
  }
  if (path === "/api/subscriptions/current") {
    return Promise.resolve<unknown>({ data: SUBSCRIPTION_OVERVIEW });
  }
  throw new Error(`Unhandled GET ${path}`);
}

function patchMockImplementation(path: string, init?: { body?: Record<string, unknown> }) {
  const body = init?.body ?? {};
  if (path === "/api/schools/current/settings") {
    schoolSettings = { ...schoolSettings, ...body, updated_at: "2026-08-16T00:00:00.000Z" };
    return Promise.resolve<unknown>({ data: schoolSettings });
  }
  if (path === "/api/users/{userId}") {
    myUser = { ...myUser, ...body, updated_at: "2026-08-16T00:00:00.000Z" };
    return Promise.resolve<unknown>({ data: myUser });
  }
  throw new Error(`Unhandled PATCH ${path}`);
}

const getMock = mock(getMockImplementation);
const patchMock = mock(patchMockImplementation);

mock.module("../../../lib/api", () => ({ api: { GET: getMock, PATCH: patchMock } }));

const loadPage = async (): Promise<ComponentType> => (await import("./SchoolSettingsPage")).default;

/** Builds a JWT-shaped string (header.payload.signature), unsigned — matches
 * `access-token-claims.test.ts` and `TimetableBuilderPage.test.tsx`. */
function fakeJwt(payload: unknown): string {
  const segment = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${segment({ alg: "RS256" })}.${segment(payload)}.signature`;
}

async function renderAsOrgAdmin(Page: ComponentType) {
  const store = createSessionStore({
    refreshClient: {
      refresh: async (): Promise<SessionTokens> => ({
        accessToken: fakeJwt({ sub: USER_ID, roles: ["ORG_ADMIN"] }),
        expiresAt: Date.now() + 3_600_000,
        sessionId: "session-1",
      }),
      logout: async () => undefined,
    },
  });
  await store.restore();

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <AuthProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <MemoryRouter>
            <Page />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>
    </AuthProvider>,
  );
}

afterEach(() => {
  cleanup();
  schoolSettings = {
    locale: "en",
    timezone: "Africa/Casablanca",
    grading_scheme: "letter",
    invitation_expiry_days: 7,
    attendance_alert_threshold: 75,
    absence_alert_threshold: 25,
    parent_discipline_visibility: false,
    attendance_correction_window_hours: 48,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
  };
  myUser = {
    id: USER_ID,
    school_id: "school-1",
    email: "admin@example.edu",
    display_name: "Jamie Admin",
    status: "active",
    roles: ["ORG_ADMIN"],
    email_verified_at: "2026-08-01T00:00:00.000Z",
    last_login_at: "2026-08-01T00:00:00.000Z",
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
  };
  getMock.mockClear();
  patchMock.mockClear();
});

describe("SchoolSettingsPage", () => {
  test("loads current values into every section", async () => {
    await renderAsOrgAdmin(await loadPage());

    expect(await screen.findByDisplayValue("Jamie Admin")).toBeTruthy();
    expect(screen.getByDisplayValue("admin@example.edu")).toBeTruthy();
    expect(screen.getByDisplayValue("Africa/Casablanca")).toBeTruthy();
    expect(screen.getByDisplayValue("7")).toBeTruthy();
    expect(screen.getByDisplayValue("75")).toBeTruthy();
    expect(screen.getByDisplayValue("25")).toBeTruthy();
    expect(screen.getByDisplayValue("48")).toBeTruthy();
  });

  test("saves the profile display name and reflects it back", async () => {
    await renderAsOrgAdmin(await loadPage());

    // `getByLabelText` would match the required-field asterisk into the label text; `getByRole`
    // with an accessible name doesn't (see packages/ui/src/components/input/input.test.tsx).
    const nameInput = await screen.findByRole("textbox", { name: "Display name" });
    fireEvent.change(nameInput, { target: { value: "Jamie Principal" } });

    const profileCard = screen.getByRole("region", { name: "Profile" });
    fireEvent.click(within(profileCard).getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith(
        "/api/users/{userId}",
        expect.objectContaining({
          params: { path: { userId: USER_ID } },
          body: { display_name: "Jamie Principal" },
        }),
      );
    });
    await screen.findByDisplayValue("Jamie Principal");
  });

  test("saves locale and timezone directly, without a confirm dialog", async () => {
    await renderAsOrgAdmin(await loadPage());

    await screen.findByDisplayValue("Africa/Casablanca");
    fireEvent.click(screen.getByRole("combobox", { name: "Default language" }));
    fireEvent.click(screen.getByRole("option", { name: "Français" }));

    const localeCard = screen.getByRole("region", { name: "Locale and timezone" });
    fireEvent.click(within(localeCard).getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith(
        "/api/schools/current/settings",
        expect.objectContaining({ body: { locale: "fr", timezone: "Africa/Casablanca" } }),
      );
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("grading scheme change asks for confirmation before saving", async () => {
    await renderAsOrgAdmin(await loadPage());

    fireEvent.click(await screen.findByRole("combobox", { name: "Grading scheme" }));
    fireEvent.click(screen.getByRole("option", { name: "Percentage (0-100%)" }));

    const gradingCard = screen.getByRole("region", { name: "Grading scheme" });
    fireEvent.click(within(gradingCard).getByRole("button", { name: "Save changes" }));

    const dialog = await screen.findByRole("dialog", { name: "Change grading scheme?" });
    expect(patchMock).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Save anyway" }));

    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith(
        "/api/schools/current/settings",
        expect.objectContaining({ body: { grading_scheme: "percentage" } }),
      );
    });
  });

  test("toggling parent discipline visibility asks for confirmation before saving", async () => {
    await renderAsOrgAdmin(await loadPage());

    const toggle = await screen.findByLabelText(
      "Parents can view their child's resolved discipline incidents",
    );
    fireEvent.click(toggle);

    const alertsCard = screen.getByRole("region", { name: "Attendance alerts" });
    fireEvent.click(within(alertsCard).getByRole("button", { name: "Save changes" }));

    const dialog = await screen.findByRole("dialog", {
      name: "Show discipline incidents to parents?",
    });
    expect(patchMock).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Save anyway" }));

    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith(
        "/api/schools/current/settings",
        expect.objectContaining({
          body: expect.objectContaining({ parent_discipline_visibility: true }),
        }),
      );
    });
  });
});
