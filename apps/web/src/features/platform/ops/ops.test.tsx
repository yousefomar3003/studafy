import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import type { ComponentType, ReactNode } from "react";

/**
 * Platform console operations: the portal-wide banner (maintenance can't be dismissed, the rest
 * can), publishing an announcement with its reason, and the read-only health, activity and flag
 * pages rendering what the API returns.
 */

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;
const SCHOOL_ID = "11111111-1111-4111-8111-111111111111";
const OPERATOR_ID = "22222222-2222-4222-8222-222222222222";

const banners = [
  {
    id: "33333333-3333-4333-8333-333333333333",
    messageEn: "Maintenance tonight 02:00–03:00 UTC",
    messageAr: null,
    severity: "maintenance",
    dismissible: false,
    endsAt: new Date(NOW + HOUR).toISOString(),
  },
  {
    id: "44444444-4444-4444-8444-444444444444",
    messageEn: "New report cards are live",
    messageAr: null,
    severity: "info",
    dismissible: true,
    endsAt: new Date(NOW + HOUR).toISOString(),
  },
];

const health = {
  generatedAt: new Date(NOW).toISOString(),
  windowDays: 7,
  jobs: {
    available: true,
    queues: [
      {
        queue: "notifications",
        deadLetter: false,
        waiting: 2,
        active: 0,
        delayed: 0,
        failed: 3,
        recentFailures: [
          {
            jobName: "dispatch",
            failedAt: new Date(NOW).toISOString(),
            attempts: 5,
            reason: "SMTP down",
          },
        ],
      },
    ],
    scheduled: [
      {
        queue: "billing",
        schedulerId: "billing-storage-quota-reconciliation-daily",
        jobName: "run-storage-quota-reconciliation",
        schedule: "0 6 * * *",
        nextRunAt: new Date(NOW + HOUR).toISOString(),
        lastRun: { at: new Date(NOW - HOUR).toISOString(), outcome: "completed", error: null },
      },
    ],
  },
  notificationDeadLetters: {
    total: 1,
    bySchool: [{ schoolId: SCHOOL_ID, schoolName: "Alpha Academy", count: 1, lastFailedAt: null }],
  },
  webhooks: { failedEvents: [], recentFailures: [], rejectedSignatures: [] },
  email: { bounces: 4, complaints: 0, deliveries: 120 },
  storage: {
    available: true,
    lastRunAt: new Date(NOW - HOUR).toISOString(),
    totals: { schools: 2, failed: 0, orphans: 3, orphanBytes: 2048 },
    schools: [
      {
        schoolId: SCHOOL_ID,
        schoolName: "Alpha Academy",
        bytesUsed: 4096,
        orphans: 3,
        orphanBytes: 2048,
        failed: false,
      },
    ],
  },
  notAvailable: ["google_play_webhook_failures"],
};

const activity = {
  entries: [
    {
      id: "55555555-5555-4555-8555-555555555555",
      createdAt: new Date(NOW).toISOString(),
      actor: {
        userId: OPERATOR_ID,
        name: "Ops",
        email: "ops@studafy.test",
        homeSchoolId: SCHOOL_ID,
      },
      action: "update",
      targetTable: "feature_flags",
      targetId: SCHOOL_ID,
      affectedSchool: { id: SCHOOL_ID, name: "Alpha Academy" },
      reason: null,
      oldValues: { flag: "ai.llm", override: null },
      newValues: { flag: "ai.llm", override: true },
      requestId: null,
    },
  ],
  nextCursor: null,
};

const flags = {
  flags: [
    {
      name: "ai.llm",
      description: "Kill switch for the LLM gateway.",
      registryDefault: false,
      deploymentDefault: false,
      overrides: [
        { schoolId: SCHOOL_ID, schoolName: "Alpha Academy", schoolStatus: "active", enabled: true },
      ],
      enabledSchools: 1,
      totalSchools: 2,
    },
  ],
};

const getMock = mock((path: string) => {
  switch (path) {
    case "/api/platform-banners":
      return Promise.resolve({ data: { banners } });
    case "/api/platform/announcements":
      return Promise.resolve({ data: { announcements: [] } });
    case "/api/platform/health":
      return Promise.resolve({ data: health });
    case "/api/platform/activity":
      return Promise.resolve({ data: activity });
    case "/api/platform/activity/operators":
      return Promise.resolve({ data: { operators: [] } });
    case "/api/platform/schools":
      return Promise.resolve({ data: { schools: [], total: 0 } });
    case "/api/platform/feature-flags":
      return Promise.resolve({ data: flags });
    default:
      return Promise.resolve({ data: undefined });
  }
});
const postMock = mock((_path: string, init: { body: Record<string, unknown> }) =>
  Promise.resolve({
    data: {
      ...init.body,
      id: "66666666-6666-4666-8666-666666666666",
      state: "live",
      createdBy: OPERATOR_ID,
      updatedBy: OPERATOR_ID,
      createdAt: new Date(NOW).toISOString(),
      updatedAt: new Date(NOW).toISOString(),
    },
  }),
);

mock.module("../../../lib/api", () => ({ api: { GET: getMock, POST: postMock, PATCH: postMock } }));

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

async function page(name: string): Promise<ComponentType> {
  const module = (await import(`./${name}`)) as { default: ComponentType };
  return module.default;
}

beforeEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    // ignore
  }
});

afterEach(() => {
  cleanup();
  getMock.mockClear();
  postMock.mockClear();
});

describe("PlatformBanners", () => {
  test("shows live banners; only the non-maintenance one can be dismissed", async () => {
    const { PlatformBanners } = await import("./PlatformBanners");
    wrap(<PlatformBanners />);

    expect(await screen.findByText(/Maintenance tonight/)).toBeTruthy();
    expect(screen.getByText(/New report cards are live/)).toBeTruthy();
    const dismissButtons = screen.getAllByRole("button", { name: /dismiss/i });
    expect(dismissButtons).toHaveLength(1);

    fireEvent.click(dismissButtons[0]!);
    await waitFor(() => expect(screen.queryByText(/New report cards are live/)).toBeNull());
    expect(screen.getByText(/Maintenance tonight/)).toBeTruthy();
  });
});

describe("AnnouncementsPage", () => {
  test("publishes an announcement with its reason", async () => {
    const Page = await page("AnnouncementsPage");
    wrap(<Page />);

    fireEvent.change(await screen.findByLabelText(/Message \(English\)/), {
      target: { value: "Scheduled maintenance" },
    });
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: "Database upgrade" } });
    fireEvent.click(screen.getByRole("button", { name: /Publish announcement/ }));

    await waitFor(() => expect(postMock).toHaveBeenCalled());
    const [path, init] = postMock.mock.calls[0]!;
    expect(path).toBe("/api/platform/announcements");
    expect(init.body).toMatchObject({
      messageEn: "Scheduled maintenance",
      reason: "Database upgrade",
      audience: "all",
      severity: "info",
    });
  });
});

describe("HealthPage", () => {
  test("renders queues, scheduled jobs, storage and what isn't recorded", async () => {
    const Page = await page("HealthPage");
    wrap(<Page />);

    expect(await screen.findByText("SMTP down")).toBeTruthy();
    expect(screen.getByText("run-storage-quota-reconciliation")).toBeTruthy();
    expect(screen.getAllByText("Alpha Academy").length).toBeGreaterThan(0);
    expect(screen.getByText(/Google Play webhook failures/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /delete/i })).toBeNull();
  });
});

describe("ActivityPage", () => {
  test("lists staff actions with the school they touched", async () => {
    const Page = await page("ActivityPage");
    wrap(<Page />);

    expect(await screen.findByText("Alpha Academy")).toBeTruthy();
    expect(screen.getByText("feature_flags")).toBeTruthy();
    expect(screen.getByText("override")).toBeTruthy();
  });
});

describe("FlagsPage", () => {
  test("shows each flag's default and the schools overriding it", async () => {
    const Page = await page("FlagsPage");
    wrap(<Page />);

    expect(await screen.findByText("ai.llm")).toBeTruthy();
    expect(screen.getByText(/On for 1 of 2 schools/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Alpha Academy" })).toBeTruthy();
  });
});
