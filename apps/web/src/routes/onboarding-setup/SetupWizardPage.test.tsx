import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { defaultProgress, saveProgress } from "./progress";

import type { ComponentType } from "react";

/**
 * Integration test for the post-activation setup wizard, mirroring
 * `routes/onboarding/OnboardingPage.test.tsx`'s pattern: `../../lib/api` is stubbed so no network
 * call is made, and the page is imported dynamically after the mock is registered.
 */

const SETTINGS_RESPONSE = {
  locale: "en" as const,
  timezone: "Africa/Casablanca",
  invitation_expiry_days: 7,
  attendance_alert_threshold: 75,
  absence_alert_threshold: 25,
  parent_discipline_visibility: false,
  attendance_correction_window_hours: 48,
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z",
};

const UPLOAD_RESPONSE = {
  id: "import-1",
  school_id: "school-1",
  uploaded_by: "user-1",
  status: "uploaded" as const,
  file_name: "students.csv",
  row_count: 2,
  valid_rows: 1,
  error_rows: 1,
  errors: [{ line: 2, field: "email", message: "Invalid email address." }],
  summary: null,
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z",
  confirmed_at: null,
  completed_at: null,
};

const getMock = mock((path: string) => {
  if (path === "/api/schools/current/settings") {
    return Promise.resolve({ data: SETTINGS_RESPONSE });
  }
  return Promise.resolve({ data: undefined });
});

const postMock = mock((path: string) => {
  if (path === "/api/academics/years") {
    return Promise.resolve({
      data: {
        id: "year-1",
        school_id: "school-1",
        code: "2025-2026",
        name: "AY 2025-2026",
        starts_on: "2025-09-01",
        ends_on: "2026-06-30",
        status: "active",
        created_at: "2026-08-01T00:00:00.000Z",
        updated_at: "2026-08-01T00:00:00.000Z",
      },
    });
  }
  if (path === "/api/academics/years/{yearId}/terms") {
    return Promise.resolve({
      data: {
        id: "term-1",
        school_id: "school-1",
        academic_year_id: "year-1",
        code: "FY",
        name: "Full Year",
        sequence_number: 1,
        starts_on: "2025-09-01",
        ends_on: "2026-06-30",
        status: "active",
        created_at: "2026-08-01T00:00:00.000Z",
        updated_at: "2026-08-01T00:00:00.000Z",
      },
    });
  }
  if (path === "/api/grades/config/schemes") {
    return Promise.resolve({
      data: {
        id: "scheme-1",
        term_id: "term-1",
        version: 1,
        name: "Standard Scale",
        scheme_type: "letter",
        grade_boundaries: [],
        is_inherited: false,
        created_at: "2026-08-01T00:00:00.000Z",
      },
    });
  }
  if (path === "/api/academics/timetable-versions") {
    return Promise.resolve({
      data: {
        id: "version-1",
        term_id: "term-1",
        academic_year_id: "year-1",
        name: "Draft Timetable",
        status: "draft",
        created_at: "2026-08-01T00:00:00.000Z",
        updated_at: "2026-08-01T00:00:00.000Z",
      },
    });
  }
  if (path === "/api/invitations/bulk") {
    return Promise.resolve({
      data: {
        id: "batch-1",
        role: "INSTRUCTOR",
        expiry_days: 7,
        target_mode: "explicit",
        total_count: 1,
        sent_count: 1,
      },
    });
  }
  if (path === "/api/imports/students/upload") {
    return Promise.resolve({ data: UPLOAD_RESPONSE });
  }
  if (path === "/api/imports/students/{importId}/confirm") {
    return Promise.resolve({
      data: { ...UPLOAD_RESPONSE, status: "confirmed", confirmed_at: "2026-08-01T00:00:00.000Z" },
    });
  }
  return Promise.resolve({ data: undefined });
});

const patchMock = mock((_path: string, _init?: unknown) => Promise.resolve({ data: undefined }));

mock.module("../../lib/api", () => ({ api: { GET: getMock, POST: postMock, PATCH: patchMock } }));

const loadSetupWizardPage = async (): Promise<ComponentType> =>
  (await import("./SetupWizardPage")).default;

function renderPage(Page: ComponentType) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/onboarding/setup"]}>
          <Routes>
            <Route path="/onboarding/setup" element={<Page />} />
            <Route path="/portal" element={<div>Portal dashboard</div>} />
          </Routes>
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

describe("SetupWizardPage", () => {
  test("walks every step, dry-runs a CSV import with row errors, and completes to the dashboard", async () => {
    renderPage(await loadSetupWizardPage());

    await screen.findByRole("heading", { name: /school profile/i });
    fireEvent.click(screen.getByRole("button", { name: /save and continue/i }));

    await screen.findByRole("heading", { name: /^academic year$/i });
    fireEvent.change(screen.getByLabelText(/year code/i), { target: { value: "2025-2026" } });
    fireEvent.change(screen.getByLabelText(/year name/i), { target: { value: "AY 2025-2026" } });
    fireEvent.change(screen.getByLabelText(/start date/i), { target: { value: "2025-09-01" } });
    fireEvent.change(screen.getByLabelText(/end date/i), { target: { value: "2026-06-30" } });
    fireEvent.click(screen.getByRole("button", { name: /save and continue/i }));

    await screen.findByRole("heading", { name: /grading scheme/i });
    fireEvent.click(screen.getByRole("button", { name: /save and continue/i }));

    await screen.findByRole("heading", { name: /timetable periods/i });
    fireEvent.click(screen.getByRole("button", { name: /save and continue/i }));

    await screen.findByRole("heading", { name: /staff invitations/i });
    fireEvent.change(screen.getByLabelText(/emails/i), {
      target: { value: "teacher@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send invitations/i }));

    await screen.findByRole("heading", { name: /student import/i });
    const file = new File(["admission_number,email\n1,not-an-email"], "students.csv", {
      type: "text/csv",
    });
    fireEvent.change(screen.getByLabelText(/student csv file/i), { target: { files: [file] } });

    expect(await screen.findByText("Invalid email address.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /confirm import/i }));

    await screen.findByText(/import confirmed/i);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await screen.findByRole("heading", { name: /setup complete/i });
    fireEvent.click(screen.getByRole("button", { name: /go to dashboard/i }));

    await screen.findByText("Portal dashboard");
  });

  test("resumes on the step recorded in progress instead of restarting", async () => {
    saveProgress({
      ...defaultProgress(),
      currentStep: "grading-scheme",
      stepState: {
        ...defaultProgress().stepState,
        "school-profile": "completed",
        "academic-year": "completed",
      },
      academicYear: {
        yearId: "year-1",
        termId: "term-1",
        code: "2025-2026",
        name: "AY 2025-2026",
        starts_on: "2025-09-01",
        ends_on: "2026-06-30",
      },
    });

    renderPage(await loadSetupWizardPage());

    await screen.findByRole("heading", { name: /grading scheme/i });
    expect(screen.queryByRole("heading", { name: /school profile/i })).toBeNull();
  });

  test("skipping the academic year step advances without creating one, and blocks grading scheme", async () => {
    renderPage(await loadSetupWizardPage());

    await screen.findByRole("heading", { name: /school profile/i });
    fireEvent.click(screen.getByRole("button", { name: /save and continue/i }));

    await screen.findByRole("heading", { name: /^academic year$/i });
    fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));

    await screen.findByRole("heading", { name: /grading scheme/i });
    expect(screen.getByRole("alert").textContent).toMatch(/create an academic year first/i);
    expect(postMock.mock.calls.some(([path]) => path === "/api/academics/years")).toBe(false);
  });
});
