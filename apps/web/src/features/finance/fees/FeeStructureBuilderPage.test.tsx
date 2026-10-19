import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import { AuthProvider, createSessionStore } from "../../../lib/auth";

import type { SessionTokens } from "../../../lib/auth";
import type { ComponentType } from "react";

/**
 * Interaction coverage for the fee structure builder: build a structure's components, see the
 * invoice preview, then create it. `preview.test.ts` covers the preview math in isolation; this
 * exercises it wired into the actual form and API calls.
 */

const YEAR = {
  id: "year-1",
  school_id: "school-1",
  code: "2025-2026",
  name: "2025-2026",
  starts_on: "2025-09-01",
  ends_on: "2026-06-30",
  status: "active" as const,
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z",
};

interface State {
  feeStructures: Record<string, unknown>[];
}

function freshState(): State {
  return { feeStructures: [] };
}

let state = freshState();

function getMockImplementation(
  path: string,
  _init?: { params?: { query?: Record<string, unknown> } },
) {
  if (path === "/api/academics/years") {
    return Promise.resolve<unknown>({ data: { academic_years: [YEAR], total: 1 } });
  }
  if (path === "/api/finance/fee-structures") {
    return Promise.resolve<unknown>({
      data: { fee_structures: state.feeStructures, total: state.feeStructures.length },
    });
  }
  throw new Error(`Unhandled GET ${path}`);
}

function postMockImplementation(path: string, init?: { body?: Record<string, unknown> }) {
  if (path === "/api/finance/fee-structures") {
    const body = init?.body ?? {};
    const structure = {
      erpnext_name: "FS-2026-0001",
      school_id: "school-1",
      academic_year_id: body.academic_year_id ?? null,
      program: body.program ?? null,
      title: body.title,
      total_amount: "1000.000",
      total_amount_minor: 1000000,
      currency: body.currency ?? "JOD",
      currency_minor_unit: 3,
      erpnext_status: "draft",
      is_active: true,
      last_synced_at: "2026-08-16T00:00:00.000Z",
    };
    state.feeStructures = [structure];
    return Promise.resolve<unknown>({ data: structure });
  }
  throw new Error(`Unhandled POST ${path}`);
}

const getMock = mock(getMockImplementation);
const postMock = mock(postMockImplementation);
const patchMock = mock((_path: string, _init?: unknown) => Promise.resolve<unknown>({ data: {} }));

mock.module("../../../lib/api", () => ({
  api: { GET: getMock, POST: postMock, PATCH: patchMock },
}));

const loadPage = async (): Promise<ComponentType> =>
  (await import("./FeeStructureBuilderPage")).default;

function fakeJwt(payload: unknown): string {
  const segment = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${segment({ alg: "RS256" })}.${segment(payload)}.signature`;
}

async function renderAsFinance(Page: ComponentType) {
  const store = createSessionStore({
    refreshClient: {
      refresh: async (): Promise<SessionTokens> => ({
        accessToken: fakeJwt({ roles: ["FINANCE"] }),
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
  state = freshState();
  getMock.mockClear();
  postMock.mockClear();
  patchMock.mockClear();
});

describe("FeeStructureBuilderPage", () => {
  test("builds components, previews the full-price invoice, and creates it", async () => {
    await renderAsFinance(await loadPage());

    await screen.findByText("No fee structures yet for this filter.");

    // --- Fill in metadata ---
    fireEvent.change(screen.getByLabelText("Title", { exact: false }), {
      target: { value: "Grade 5 Fees" },
    });

    // --- Compose the one starting component row ---
    fireEvent.change(screen.getByLabelText("Fee category", { exact: false }), {
      target: { value: "Tuition" },
    });
    fireEvent.change(screen.getByLabelText("Amount", { exact: false }), {
      target: { value: "1000" },
    });

    await screen.findByText("Subtotal: 1000.000 JOD");

    // No scholarships or discounts: the previewed invoice is the components at full price.
    await waitFor(() => {
      const totalRow = screen.getByText("Total").closest("tr");
      expect(totalRow?.textContent).toContain("1000.000 JOD");
    });
    expect(screen.queryByLabelText("Sample student", { exact: false })).toBeNull();

    // --- Create it ---
    fireEvent.click(screen.getByRole("button", { name: "Create fee structure" }));

    await waitFor(() => {
      const call = postMock.mock.calls.find(([path]) => path === "/api/finance/fee-structures");
      expect(call).toBeDefined();
    });
    const [, createInit] = postMock.mock.calls.find(
      ([path]) => path === "/api/finance/fee-structures",
    )!;
    expect((createInit as { body: Record<string, unknown> }).body).toMatchObject({
      title: "Grade 5 Fees",
      currency: "JOD",
      components: [{ fee_category: "Tuition", amount: 1000 }],
    });

    await screen.findByText("Grade 5 Fees", { selector: "button" });
  });

  test("shows an inline error instead of submitting when no components are filled in", async () => {
    await renderAsFinance(await loadPage());
    await screen.findByText("No fee structures yet for this filter.");

    fireEvent.change(screen.getByLabelText("Title", { exact: false }), {
      target: { value: "Empty structure" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create fee structure" }));

    await screen.findByRole("alert");
    expect(postMock.mock.calls.some(([path]) => path === "/api/finance/fee-structures")).toBe(
      false,
    );
  });
});
