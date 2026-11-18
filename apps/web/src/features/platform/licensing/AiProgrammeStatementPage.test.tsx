import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";

import { SCHOOL_ID } from "../../ai-programme/test-fixtures";
import { renderAs } from "../../license/test-utils";

import type { ComponentType } from "react";

/**
 * The Student AI weekly statements in the console: the queue (waiting first, by status), and one
 * statement -- its figures, its students' months and licence shares -- approved with the figures
 * shown, held or rejected with a note.
 */

interface Init {
  params?: { path?: Record<string, string>; query?: Record<string, string> };
  body?: Record<string, unknown>;
}

const STATEMENT_ID = "st000000-0000-4000-8000-000000000001";

function statement(status = "awaiting_approval") {
  return {
    id: STATEMENT_ID,
    schoolId: SCHOOL_ID,
    weekStart: "2026-11-16",
    weekEnd: "2026-11-22",
    currencyCode: "USD",
    minorUnit: 2,
    monthsCount: 3,
    grossMinor: 1200,
    shareMinor: 156,
    netMinor: 1044,
    licenceShareCount: 1,
    licenceShareMinor: 18200,
    status,
    decidedAt: null,
    decidedBy: null,
    decisionNote: null,
    invoiceId: null,
    invoiceNumber: null,
    createdAt: "2026-11-23T06:00:00.000Z",
  };
}

function detail(status = "awaiting_approval") {
  return {
    ...statement(status),
    months: [
      {
        id: "m1",
        studentId: "st1",
        studentName: "Amina Tazi",
        month: "2026-12-01",
        collectedOn: "2026-11-18",
        priceMinor: 400,
        shareBps: 1300,
        shareMinor: 52,
        status: "collected",
      },
    ],
    shares: [
      {
        id: "e1",
        licenseId: "l1",
        invoiceNumber: "LIC-2026-000042",
        periodFrom: "2026-11-01",
        periodTo: "2026-11-30",
        measurementPeriodStart: "2026-11-01",
        totalBps: 1300,
        amountMinor: 18200,
        status: "awaiting_approval",
      },
    ],
  };
}

const getMock = mock((path: string, init?: Init) => {
  switch (path) {
    case "/api/platform/ai-revenue-share/statements":
      return Promise.resolve({
        data: {
          statements: [
            {
              ...statement(init?.params?.query?.status ?? "awaiting_approval"),
              schoolName: "Atlas Academy",
            },
          ],
        },
      });
    case "/api/platform/schools/{schoolId}/ai-revenue-share/statements/{statementId}":
      return Promise.resolve({ data: detail() });
    default:
      throw new Error(`Unhandled GET ${path}`);
  }
});

const postMock = mock((path: string) => {
  if (path.endsWith("/approve")) return Promise.resolve({ data: detail("approved") });
  if (path.endsWith("/hold")) return Promise.resolve({ data: detail("held") });
  if (path.endsWith("/reject")) return Promise.resolve({ data: detail("rejected") });
  throw new Error(`Unhandled POST ${path}`);
});

mock.module("../../../lib/api", () => ({ api: { GET: getMock, POST: postMock } }));

const callsTo = (suffix: string) =>
  postMock.mock.calls.filter(([p]) => String(p).endsWith(suffix)) as unknown as [string, Init][];

async function renderList() {
  const Page: ComponentType = (await import("./AiProgrammeStatementsPage")).default;
  return renderAs("SUPER_ADMIN", <Page />, {
    path: "/portal/platform/ai-programme/statements",
    at: "/portal/platform/ai-programme/statements",
  });
}

async function renderDetail() {
  const Page: ComponentType = (await import("./AiProgrammeStatementPage")).default;
  return renderAs("SUPER_ADMIN", <Page />, {
    path: "/portal/platform/ai-programme/statements/:schoolId/:statementId",
    at: `/portal/platform/ai-programme/statements/${SCHOOL_ID}/${STATEMENT_ID}`,
  });
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
  postMock.mockClear();
});

describe("AiProgrammeStatementsPage", () => {
  test("the queue: waiting statements first, each school's net, linked to the statement", async () => {
    await renderList();
    const table = await screen.findByTestId("statements");
    expect(table.textContent).toContain("Atlas Academy");
    expect(table.textContent).toContain("$10.44");
    expect(table.textContent).toContain("Awaiting approval");
    expect(getMock.mock.calls[0]![1]).toMatchObject({
      params: { query: { status: "awaiting_approval" } },
    });
    expect(
      screen.getByRole("link", { name: /Open Atlas Academy's statement/ }).getAttribute("href"),
    ).toBe(`/portal/platform/ai-programme/statements/${SCHOOL_ID}/${STATEMENT_ID}`);
  });
});

describe("AiProgrammeStatementPage", () => {
  test("the figures, the students' months and the licence shares", async () => {
    await renderDetail();
    expect(await screen.findByTestId("statement-months")).toBeTruthy();
    expect(screen.getByTestId("statement-months").textContent).toContain("Amina Tazi");
    expect(screen.getByTestId("statement-shares").textContent).toContain("LIC-2026-000042");
    expect(screen.getByTestId("approve-explainer").textContent).toContain("$10.44");
    expect(screen.getByTestId("approve-explainer").textContent).toContain("$182.00");
  });

  test("approve sends the figures shown", async () => {
    await renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(callsTo("/approve")).toHaveLength(1));
    expect(callsTo("/approve")[0]![1].body).toEqual({
      expectedNetMinor: 1044,
      expectedLicenceShareMinor: 18200,
    });
  });

  test("hold and reject need a note", async () => {
    await renderDetail();
    const hold = await screen.findByRole("button", { name: "Hold" });
    const reject = screen.getByRole("button", { name: "Reject" });
    expect((hold as HTMLButtonElement).disabled).toBe(true);
    expect((reject as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Note or reason/), {
      target: { value: "Duplicate transfer" },
    });
    fireEvent.click(reject);
    await waitFor(() => expect(callsTo("/reject")).toHaveLength(1));
    expect(callsTo("/reject")[0]![1].body).toEqual({ reason: "Duplicate transfer" });
  });
});
