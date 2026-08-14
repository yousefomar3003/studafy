import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import { expectNoA11yViolations } from "../../lib/test/axe";

import { defaultProgress, saveProgress } from "./progress";

import type { ComponentType } from "react";

/**
 * Automated accessibility audit for the setup wizard, one render per representative step —
 * mirrors `routes/onboarding/a11y.test.tsx`'s approach of rendering inside a `<main>`, matching how
 * `RootLayout` wraps every route in production. Each step is reached by seeding `localStorage`
 * directly (see `progress.ts`) rather than clicking through the whole flow.
 */

const getMock = mock((_path: string) => Promise.resolve({ data: undefined }));
const postMock = mock((_path: string, _init?: unknown) => Promise.resolve({ data: undefined }));
const patchMock = mock((_path: string, _init?: unknown) => Promise.resolve({ data: undefined }));

mock.module("../../lib/api", () => ({ api: { GET: getMock, POST: postMock, PATCH: patchMock } }));

const loadSetupWizardPage = async (): Promise<ComponentType> =>
  (await import("./SetupWizardPage")).default;

function renderInMain(Page: ComponentType) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/onboarding/setup"]}>
          <main>
            <Page />
          </main>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  getMock.mockClear();
  postMock.mockClear();
  patchMock.mockClear();
});

describe("setup wizard accessibility", () => {
  test("school profile step", async () => {
    // Cached values present, so the step skips its server-prefill fetch — this snapshot is of the
    // rendered form itself, not the prefill race, which the fetch-mocked `SetupWizardPage.test.tsx`
    // suite already exercises.
    saveProgress({
      ...defaultProgress(),
      schoolProfile: {
        locale: "en",
        timezone: "Africa/Casablanca",
        invitation_expiry_days: 7,
        attendance_alert_threshold: 75,
        absence_alert_threshold: 25,
        parent_discipline_visibility: false,
        attendance_correction_window_hours: 48,
      },
    });

    const { container } = renderInMain(await loadSetupWizardPage());

    await screen.findByRole("heading", { name: /school profile/i });

    await expectNoA11yViolations(container);
  });

  test("student import step, before a file is uploaded", async () => {
    saveProgress({
      ...defaultProgress(),
      currentStep: "students",
      stepState: {
        ...defaultProgress().stepState,
        "school-profile": "skipped",
        "academic-year": "skipped",
        "grading-scheme": "skipped",
        timetable: "skipped",
        staff: "skipped",
      },
    });

    const { container } = renderInMain(await loadSetupWizardPage());

    await screen.findByRole("heading", { name: /student import/i });

    await expectNoA11yViolations(container);
  });

  test("completion screen", async () => {
    saveProgress({ ...defaultProgress(), currentStep: "complete" });

    const { container } = renderInMain(await loadSetupWizardPage());

    await screen.findByRole("heading", { name: /setup complete/i });

    await expectNoA11yViolations(container);
  });
});
