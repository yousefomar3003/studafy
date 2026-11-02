import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import type { ComponentType } from "react";

/**
 * The school application page: no applicant session sends the visitor back to /signup; a new
 * applicant gets the form, which uploads the proof first and then submits every field; an applicant
 * with an open application sees its status instead of the form.
 */

const COUNTRY_ID = "33333333-3333-4333-8333-333333333333";
const CURRENCY_ID = "44444444-4444-4444-8444-444444444444";

type Me = {
  applicant: { email: string; name: string | null; provider: "google" | "microsoft" };
  application: null | {
    id: string;
    status: "pending" | "approved" | "rejected";
    school_name: string;
    created_at: string;
    reviewed_at: string | null;
    review_note: string | null;
  };
} | null;

let me: Me = null;

const applicantGet = mock(() => Promise.resolve({ data: me }));
const applicantPost = mock((path: string, _init?: { body: Record<string, unknown> }) => {
  if (path === "/api/school-applications/me/proof-upload-url") {
    return Promise.resolve({
      data: {
        upload_url: "https://files.test/upload",
        storage_key: "temp/school-applications/abc/registration.pdf",
        expires_at: "2026-10-16T10:00:00.000Z",
      },
    });
  }
  return Promise.resolve({ data: {} });
});
// The proof PUT goes straight to storage via the global fetch; stubbed per test and restored after.
const originalFetch = globalThis.fetch;
const uploadMock = mock(() => Promise.resolve(new Response(null, { status: 200 })));

mock.module("./applicant-api", () => ({
  APPLICANT_KEY: ["school-applicant"],
  applicantApi: { GET: applicantGet, POST: applicantPost },
  useApplicantQuery: () =>
    useQuery({
      queryKey: ["school-applicant"],
      queryFn: async () => (await applicantGet()).data,
    }),
}));
mock.module("../../lib/api", () => ({
  api: {
    GET: (path: string) =>
      Promise.resolve({
        data:
          path === "/api/lookups/countries"
            ? { countries: [{ id: COUNTRY_ID, alpha2_code: "SA", name: "Saudi Arabia" }] }
            : { currencies: [{ id: CURRENCY_ID, code: "SAR", name: "Saudi Riyal" }] },
      }),
  },
}));

const loadPage = async (): Promise<ComponentType> => (await import("./ApplyPage")).default;

async function renderPage() {
  const Page = await loadPage();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/signup/apply"]}>
        <Routes>
          <Route path="/signup/apply" element={<Page />} />
          <Route path="/signup" element={<p>sign-up start</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  me = null;
  applicantGet.mockClear();
  applicantPost.mockClear();
  uploadMock.mockClear();
  globalThis.fetch = originalFetch;
});

describe("ApplyPage", () => {
  test("without an applicant session it goes back to /signup", async () => {
    await renderPage();
    expect(await screen.findByText("sign-up start")).toBeTruthy();
  });

  test("an open application shows its status, not the form", async () => {
    me = {
      applicant: { email: "sara@gmail.com", name: "Sara", provider: "google" },
      application: {
        id: "app-1",
        status: "pending",
        school_name: "Al Noor International",
        created_at: "2026-10-16T09:00:00.000Z",
        reviewed_at: null,
        review_note: null,
      },
    };
    await renderPage();
    expect(
      await screen.findByRole("heading", { name: "We're reviewing Al Noor International" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Submit application" })).toBeNull();
  });

  test("the form requires a proof file, uploads it, then submits every field", async () => {
    me = {
      applicant: { email: "sara@gmail.com", name: "Sara Al-Ahmad", provider: "google" },
      application: null,
    };
    globalThis.fetch = uploadMock as unknown as typeof fetch;
    await renderPage();
    const submit = await screen.findByRole("button", { name: "Submit application" });

    fireEvent.click(submit);
    expect(await screen.findByText("Upload a proof of ownership document.")).toBeTruthy();
    expect(applicantPost).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/^School name/), {
      target: { value: "Al Noor International" },
    });
    fireEvent.click(screen.getByRole("combobox", { name: /^country/i }));
    fireEvent.click(await screen.findByRole("option", { name: /saudi arabia/i }));
    fireEvent.change(screen.getByLabelText(/^City/), { target: { value: "Riyadh" } });
    fireEvent.change(screen.getByLabelText(/^Address/), {
      target: { value: "King Fahd Rd, Al Olaya" },
    });
    fireEvent.click(screen.getByRole("combobox", { name: /currency/i }));
    fireEvent.click(await screen.findByRole("option", { name: /saudi riyal/i }));
    fireEvent.change(screen.getByLabelText(/^Phone number/), {
      target: { value: "+966 50 123 4567" },
    });
    const file = new File(["%PDF-1.7"], "registration.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText(/^Proof document/), { target: { files: [file] } });

    fireEvent.click(submit);

    await waitFor(() => expect(applicantPost).toHaveBeenCalledTimes(2));
    expect(applicantPost.mock.calls[0]![0]).toBe("/api/school-applications/me/proof-upload-url");
    expect(applicantPost.mock.calls[0]![1]!.body).toEqual({
      file_name: "registration.pdf",
      content_type: "application/pdf",
      size_bytes: file.size,
    });
    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(applicantPost.mock.calls[1]![0]).toBe("/api/school-applications/me");
    expect(applicantPost.mock.calls[1]![1]!.body).toMatchObject({
      applicant_name: "Sara Al-Ahmad",
      applicant_phone: "+966 50 123 4567",
      school_name: "Al Noor International",
      country_id: COUNTRY_ID,
      default_currency_id: CURRENCY_ID,
      city: "Riyadh",
      address: "King Fahd Rd, Al Olaya",
      proof_storage_key: "temp/school-applications/abc/registration.pdf",
      proof_file_name: "registration.pdf",
    });
  });
});
