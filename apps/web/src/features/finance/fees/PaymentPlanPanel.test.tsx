import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";

import { callTo, renderFinance } from "../test-utils";

import type { FeeStructure } from "./queries";

const STRUCTURE = {
  erpnext_name: "FS-2026-0001",
  school_id: "school-1",
  academic_year_id: "year-1",
  program: "Grade 5",
  title: "Grade 5 Fees",
  total_amount: "1200.000",
  total_amount_minor: 1_200_000,
  currency: "JOD",
  currency_minor_unit: 3,
  erpnext_status: "submitted",
  is_active: true,
  last_synced_at: "2026-09-01T00:00:00.000Z",
} as FeeStructure;

let students = [
  { id: "student-1", name: "Omar Saleh", admission_number: "ADM-1" },
  { id: "student-2", name: "Lina Haddad", admission_number: "ADM-2" },
];

const getMock = mock((path: string, _init?: unknown) =>
  Promise.resolve({
    data:
      path === "/api/finance/fee-structures/{feeStructureId}/students" ? { students } : undefined,
  }),
);
const postMock = mock((_path: string, _init?: unknown) =>
  Promise.resolve({ data: { installments: [], total: 4 } }),
);

mock.module("../../../lib/api", () => ({ api: { GET: getMock, POST: postMock } }));

afterEach(() => {
  cleanup();
  getMock.mockClear();
  postMock.mockClear();
  students = [
    { id: "student-1", name: "Omar Saleh", admission_number: "ADM-1" },
    { id: "student-2", name: "Lina Haddad", admission_number: "ADM-2" },
  ];
});

const load = async () => (await import("./PaymentPlanPanel")).PaymentPlanPanel;

describe("PaymentPlanPanel", () => {
  test("creates installments for the structure's students on the chosen due dates", async () => {
    const Panel = await load();
    await renderFinance(<Panel structure={STRUCTURE} />);

    expect(await screen.findByText("For 2 students.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Due date 1/), { target: { value: "2026-11-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Add a due date" }));
    fireEvent.change(screen.getByLabelText(/Due date 2/), { target: { value: "2026-10-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Create installments" }));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(callTo(postMock.mock.calls, "/api/finance/fee-schedules/generate")?.body).toEqual({
      fee_structure: "FS-2026-0001",
      student_ids: ["student-1", "student-2"],
      due_dates: ["2026-10-01", "2026-11-01"],
      schedule_type: "term_wise",
      academic_year_id: "year-1",
      program: "Grade 5",
    });
    expect(await screen.findByText(/4 installments created\./)).toBeTruthy();
  });

  test("the same due date twice is refused before anything is sent", async () => {
    const Panel = await load();
    await renderFinance(<Panel structure={STRUCTURE} />);
    await screen.findByText("For 2 students.");
    fireEvent.change(screen.getByLabelText(/Due date 1/), { target: { value: "2026-11-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Add a due date" }));
    fireEvent.change(screen.getByLabelText(/Due date 2/), { target: { value: "2026-11-01" } });
    expect(screen.getByText("Each due date can be used once.")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Create installments" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  test("a draft structure, or one with no students, says what to do first", async () => {
    const Panel = await load();
    const { unmount } = await renderFinance(
      <Panel structure={{ ...STRUCTURE, erpnext_status: "draft" }} />,
    );
    expect(await screen.findByText(/Submit this structure in ERPNext/)).toBeTruthy();
    unmount();

    students = [];
    await renderFinance(<Panel structure={STRUCTURE} />);
    expect(await screen.findByText("Save the students this structure is for first.")).toBeTruthy();
  });
});
