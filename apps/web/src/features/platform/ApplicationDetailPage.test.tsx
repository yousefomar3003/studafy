import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import type { ComponentType } from "react";

/**
 * The console's school application page: every field the applicant filled in and their proof are
 * shown, approving sends an optional note, and rejecting cannot be sent without a reason.
 */

const APPLICATION_ID = "22222222-2222-4222-8222-222222222222";

function application(status: "pending" | "approved" | "rejected") {
  return {
    id: APPLICATION_ID,
    status,
    schoolName: "Al Noor International",
    applicantName: "Sara Al-Ahmad",
    applicantEmail: "sara@gmail.com",
    provider: "google",
    countryName: "Saudi Arabia",
    countryCode: "SA",
    city: "Riyadh",
    createdAt: "2026-10-16T09:00:00.000Z",
    reviewedAt: status === "pending" ? null : "2026-10-16T10:00:00.000Z",
    applicantJobTitle: "Owner",
    applicantPhone: "+966 50 123 4567",
    schoolEmail: null,
    countryId: "33333333-3333-4333-8333-333333333333",
    currencyId: "44444444-4444-4444-8444-444444444444",
    currencyCode: "SAR",
    address: "King Fahd Rd, Al Olaya",
    website: null,
    studentCount: 450,
    message: null,
    proof: {
      fileName: "registration.pdf",
      contentType: "application/pdf",
      sizeBytes: 204_800,
      url: "https://files.test/proof.pdf",
    },
    reviewNote: status === "rejected" ? "Unreadable document" : null,
    reviewedByUserId: null,
    schoolId: status === "approved" ? "55555555-5555-4555-8555-555555555555" : null,
    teamNotifiedAt: null,
    applicantNotifiedAt: null,
    updatedAt: "2026-10-16T09:00:00.000Z",
  };
}

let current = application("pending");

const getMock = mock(() => Promise.resolve({ data: current }));
const postMock = mock((path: string, init: { body: { note?: string; reason?: string } }) => {
  current = application(path.endsWith("/approve") ? "approved" : "rejected");
  if (init.body.reason) current = { ...current, reviewNote: init.body.reason };
  return Promise.resolve({ data: current });
});

mock.module("../../lib/api", () => ({ api: { GET: getMock, POST: postMock } }));

const loadPage = async (): Promise<ComponentType> =>
  (await import("./ApplicationDetailPage")).default;

async function renderPage() {
  const Page = await loadPage();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={[`/portal/platform/applications/${APPLICATION_ID}`]}>
          <Routes>
            <Route path="/portal/platform/applications/:applicationId" element={<Page />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  current = application("pending");
  getMock.mockClear();
  postMock.mockClear();
});

describe("ApplicationDetailPage", () => {
  test("shows what the applicant submitted and links the proof", async () => {
    await renderPage();
    await screen.findByRole("heading", { name: "Al Noor International", level: 1 });

    expect(screen.getByText("King Fahd Rd, Al Olaya")).toBeTruthy();
    expect(screen.getByText("+966 50 123 4567")).toBeTruthy();
    expect(screen.getByText("registration.pdf")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Open the file in a new tab" });
    expect(link.getAttribute("href")).toBe("https://files.test/proof.pdf");
  });

  test("rejecting requires a reason and sends it", async () => {
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Reject" }));

    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Reject" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(within(dialog).getByLabelText(/Reason/), {
      target: { value: "Unreadable document" },
    });
    fireEvent.click(confirm);

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    const [path, init] = postMock.mock.calls[0]!;
    expect(path).toBe("/api/platform/school-applications/{applicationId}/reject");
    expect(init.body).toEqual({ reason: "Unreadable document" });
  });

  test("approving sends the optional note and shows the created school", async () => {
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));

    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    const [path, init] = postMock.mock.calls[0]!;
    expect(path).toBe("/api/platform/school-applications/{applicationId}/approve");
    expect(init.body).toEqual({ note: undefined });
    expect(await screen.findByRole("link", { name: "Al Noor International" })).toBeTruthy();
  });
});
