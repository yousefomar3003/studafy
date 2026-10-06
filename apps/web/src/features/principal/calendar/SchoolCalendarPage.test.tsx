import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import { AuthProvider, createSessionStore } from "../../../lib/auth";
import { todayIso } from "../school/queries";

import type { SessionTokens } from "../../../lib/auth";
import type { ComponentType } from "react";

// Everything sits in the current month, so the page's default view shows it.
const now = new Date();
const day = (n: number) => todayIso(new Date(now.getFullYear(), now.getMonth(), n));

function responseFor(path: string): Promise<{ data?: unknown; error?: unknown }> {
  switch (path) {
    case "/api/academics/years":
      return Promise.resolve({
        data: {
          academic_years: [
            { id: "y1", name: "Year", status: "active", starts_on: day(1), ends_on: day(28) },
          ],
          total: 1,
        },
      });
    case "/api/academics/years/{yearId}/terms":
      return Promise.resolve({
        data: {
          terms: [{ id: "t1", name: "Term 1", starts_on: day(2), ends_on: day(27) }],
          total: 1,
        },
      });
    case "/api/academics/classes":
      return Promise.resolve({ data: { classes: [{ id: "c1", code: "SCI101-A" }], total: 1 } });
    case "/api/academics/exams":
      return Promise.resolve({
        data: {
          exams: [
            {
              id: "e1",
              class_id: "c1",
              title: "Unit test",
              starts_at: new Date(now.getFullYear(), now.getMonth(), 10, 9).toISOString(),
            },
          ],
          total: 1,
        },
      });
    case "/api/school-events":
      return Promise.resolve({
        data: {
          items: [
            {
              id: "ev1",
              title: "Founders' day",
              kind: "holiday",
              starts_on: day(15),
              ends_on: day(16),
              description: null,
            },
          ],
        },
      });
    default:
      return Promise.resolve({ data: undefined });
  }
}

const getMock = mock((path: string) => responseFor(path));
mock.module("../../../lib/api", () => ({ api: { GET: getMock } }));

function fakeJwt(payload: unknown): string {
  const segment = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${segment({ alg: "RS256" })}.${segment(payload)}.signature`;
}

async function renderAs(role: string) {
  const Page: ComponentType = (await import("./SchoolCalendarPage")).default;
  const store = createSessionStore({
    refreshClient: {
      refresh: async (): Promise<SessionTokens> => ({
        accessToken: fakeJwt({ roles: [role] }),
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
        <MemoryRouter>
          <Page />
        </MemoryRouter>
      </QueryClientProvider>
    </AuthProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe("monthGrid", () => {
  test("covers six whole weeks starting on the Sunday on or before the 1st", async () => {
    const { monthGrid } = await import("./SchoolCalendarPage");
    const grid = monthGrid(new Date(2026, 9, 15)); // October 2026; the 1st is a Thursday
    expect(grid).toHaveLength(42);
    expect(grid[0]).toBe("2026-09-27");
    expect(grid[4]).toBe("2026-10-01");
    expect(grid.at(-1)).toBe("2026-11-07");
  });
});

describe("SchoolCalendarPage", () => {
  test("lists the month's term dates, exams and events, and lets a principal manage events", async () => {
    await renderAs("PRINCIPAL");
    expect(await screen.findByRole("button", { name: "Founders' day" })).toBeTruthy();
    // Exams arrive last (years → terms → classes → exams), so wait for each rather than assume.
    expect((await screen.findAllByText("Term 1 starts")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("Unit test (SCI101-A)")).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Add event" })).toBeTruthy();
  });

  test("shows a teacher the calendar read-only", async () => {
    await renderAs("INSTRUCTOR");

    expect((await screen.findAllByText("Founders' day")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Add event" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Founders' day" })).toBeNull();
  });
});
