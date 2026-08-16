import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import { AuthProvider, createSessionStore } from "../../../lib/auth";
import { expectNoA11yViolations } from "../../../lib/test/axe";

import type { SessionTokens } from "../../../lib/auth";
import type { ComponentType } from "react";

/**
 * Automated accessibility audit for the settings hub, mirroring `features/admin/invitations/a11y.test.tsx`
 * — one render per representative state (the page at rest, and the grading-scheme confirm dialog open,
 * since a Modal's focus trap and labelling are exactly the kind of thing axe catches).
 */

const USER_ID = "user-1";

const SCHOOL_SETTINGS = {
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

const MY_USER = {
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

function getMockImplementation(path: string): Promise<{ data: unknown }> {
  if (path === "/api/schools/current/settings") return Promise.resolve({ data: SCHOOL_SETTINGS });
  if (path === "/api/users/{userId}") return Promise.resolve({ data: MY_USER });
  if (path === "/api/subscriptions/current")
    return Promise.resolve({ data: SUBSCRIPTION_OVERVIEW });
  return Promise.resolve({ data: undefined });
}

const getMock = mock(getMockImplementation);
const patchMock = mock((_path: string) => Promise.resolve<unknown>({ data: {} }));

mock.module("../../../lib/api", () => ({ api: { GET: getMock, PATCH: patchMock } }));

const loadPage = async (): Promise<ComponentType> => (await import("./SchoolSettingsPage")).default;

function fakeJwt(payload: unknown): string {
  const segment = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${segment({ alg: "RS256" })}.${segment(payload)}.signature`;
}

async function renderInMain(Page: ComponentType) {
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
});

describe("settings feature accessibility", () => {
  test("settings hub at rest", async () => {
    const { container } = await renderInMain(await loadPage());
    await screen.findByDisplayValue("Jamie Admin");

    await expectNoA11yViolations(container);
  });

  test("grading scheme confirm dialog open", async () => {
    const { container } = await renderInMain(await loadPage());
    await screen.findByDisplayValue("Jamie Admin");

    fireEvent.click(screen.getByRole("combobox", { name: "Grading scheme" }));
    fireEvent.click(screen.getByRole("option", { name: "Percentage (0-100%)" }));
    const gradingCard = screen.getByRole("region", { name: "Grading scheme" });
    fireEvent.click(gradingCard.querySelector("button[type=submit]")!);
    await screen.findByRole("dialog", { name: "Change grading scheme?" });

    await expectNoA11yViolations(container);
  });
});
