import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import { expectNoA11yViolations } from "../../../lib/test/axe";
import { xlsxToCsv } from "../../../lib/xlsx";

import type { LoginSlip } from "./LoginSlipsPage";
import type { ComponentType } from "react";

const EXPIRES_AT = "2026-11-25T09:00:00.000Z";

function issued(id: string, name: string, code: string, extra: Record<string, unknown> = {}) {
  return {
    user_id: id,
    display_name: name,
    usernames: [code],
    setup_code: `CODE-${code}`,
    expires_at: EXPIRES_AT,
    class_label: null,
    children: [],
    ...extra,
  };
}

/** Body of every POST, in order. */
let posted: Record<string, unknown>[] = [];
let batches: unknown[] = [];

const postMock = mock((_path: string, init: { body: Record<string, unknown> }) => {
  posted.push(init.body);
  return Promise.resolve({ data: batches.shift() ?? { issued: [], remaining: 0, last: null } });
});

mock.module("../../../lib/api", () => ({ api: { POST: postMock } }));

async function renderPage() {
  const { default: Page } = (await import("./LoginSlipsPage")) as {
    default: ComponentType;
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter>
          {/* The portal renders every page inside its <main> landmark. */}
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
  posted = [];
  batches = [];
  postMock.mockClear();
});

describe("sortSlips", () => {
  test("orders by class, then name; parents follow their first child", async () => {
    const { sortSlips } = await import("./LoginSlipsPage");
    const slip = (name: string, classLabel: string | null, children: string[] = []): LoginSlip => ({
      userId: name,
      name,
      usernames: [],
      setupCode: "",
      expiresAt: EXPIRES_AT,
      classLabel,
      children,
    });
    const sorted = sortSlips(
      [
        slip("Zaid", "Grade 10 – A"),
        slip("Ali", "Grade 2 – B"),
        slip("Sara", "Grade 2 – A"),
        slip("Unplaced", null),
        slip("Mona", null, ["Ali Hassan"]),
      ],
      "en",
    );
    expect(sorted.map((s) => s.name)).toEqual(["Sara", "Ali", "Zaid", "Mona", "Unplaced"]);
  });
});

describe("LoginSlipsPage", () => {
  test("prepares slips for students and shows ID, code and class", async () => {
    batches = [
      {
        issued: [
          issued("u2", "Sara Hassan", "STU-100002", { class_label: "Grade 1 – B" }),
          issued("u1", "Ali Hassan", "STU-100001", { class_label: "Grade 1 – A" }),
        ],
        remaining: 0,
        last: "STU-100002",
      },
    ];
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Prepare slips" }));

    const list = within(await screen.findByRole("list", { name: "Login slips" }));
    const slips = list.getAllByRole("listitem");
    expect(slips.map((slip) => slip.querySelector(".login-slip__name")?.textContent)).toEqual([
      "Ali Hassan",
      "Sara Hassan",
    ]);
    expect(list.getByText("STU-100001")).toBeTruthy();
    expect(list.getByText("CODE-STU-100001")).toBeTruthy();
    expect(list.getByText("Grade 1 – A")).toBeTruthy();
    expect(screen.getByText(/2 slips are ready/)).toBeTruthy();
    expect(posted).toEqual([{ role: "STUDENT" }]);
    await expectNoA11yViolations(document.body);
  });

  test("a reprint pages with `after` until nothing remains, and warns first", async () => {
    batches = [
      { issued: [issued("p1", "Mona", "PAR-100001")], remaining: 1, last: "PAR-100001" },
      {
        issued: [issued("p2", "Omar", "PAR-100002", { children: ["Ali Hassan", "Sara Hassan"] })],
        remaining: 0,
        last: "PAR-100002",
      },
    ];
    await renderPage();
    fireEvent.click(screen.getByRole("combobox", { name: /^Slips for/ }));
    fireEvent.click(screen.getByRole("option", { name: "Parents" }));
    fireEvent.click(screen.getByLabelText(/Also reprint slips/));
    expect(screen.getByText(/will stop working/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Prepare slips" }));
    await screen.findByRole("list", { name: "Login slips" });
    expect(posted).toEqual([
      { role: "PARENT", include_pending: true },
      { role: "PARENT", include_pending: true, after: "PAR-100001" },
    ]);
    expect(screen.getByText("Parent of Ali Hassan, Sara Hassan")).toBeTruthy();
  });

  test("attendance officers get slips too", async () => {
    batches = [
      { issued: [issued("a1", "Huda Saleh", "ATT-100001")], remaining: 0, last: "ATT-100001" },
    ];
    await renderPage();
    fireEvent.click(screen.getByRole("combobox", { name: /^Slips for/ }));
    fireEvent.click(screen.getByRole("option", { name: "Attendance officers" }));
    fireEvent.click(screen.getByRole("button", { name: "Prepare slips" }));
    const list = within(await screen.findByRole("list", { name: "Login slips" }));
    expect(list.getByText("ATT-100001")).toBeTruthy();
    expect(posted).toEqual([{ role: "ATTENDANCE_OFFICER" }]);
  });

  test("the slips download as an Excel sheet, in the order shown, every cell as text", async () => {
    batches = [
      {
        issued: [
          issued("u2", "Sara Hassan", "STU-100002", { class_label: "Grade 1 – B" }),
          issued("u1", "Ali Hassan", "STU-100001", { class_label: "Grade 1 – A" }),
        ],
        remaining: 0,
        last: "STU-100002",
      },
    ];
    let saved: Blob | null = null;
    const createObjectURL = URL.createObjectURL;
    const revokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = (blob: Blob) => {
      saved = blob;
      return "blob:slips";
    };
    URL.revokeObjectURL = () => undefined;
    try {
      await renderPage();
      fireEvent.click(screen.getByRole("button", { name: "Prepare slips" }));
      await screen.findByRole("list", { name: "Login slips" });
      expect(screen.getByText(/Keep it private/)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Download Excel" }));
      expect(saved).not.toBeNull();
      const rows = xlsxToCsv(new Uint8Array(await saved!.arrayBuffer()))
        .trim()
        .split("\n");
      expect(rows[0]).toBe(
        "Name,Class,Parent of,Studafy ID,One-time code,Code works until,Sign in at",
      );
      expect(rows.slice(1).map((row) => row.split(",").slice(0, 5))).toEqual([
        ["Ali Hassan", "Grade 1 – A", "", "STU-100001", "CODE-STU-100001"],
        ["Sara Hassan", "Grade 1 – B", "", "STU-100002", "CODE-STU-100002"],
      ]);
      expect(rows[1]).toContain("/auth/login");
    } finally {
      URL.createObjectURL = createObjectURL;
      URL.revokeObjectURL = revokeObjectURL;
    }
  });

  test("says so when everyone already has a way in", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Prepare slips" }));
    await waitFor(() => expect(screen.getByText(/Everyone has already signed in/)).toBeTruthy());
  });
});
