import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import { AuthProvider } from "../../lib/auth";
import { expectNoA11yViolations } from "../../lib/test/axe";
import { createTestSessionStore } from "../../lib/test/session";

/**
 * The Lists panel on a student's (parent's, staff member's, class's) page: each list linking to
 * them with its rows, sensitive cells as masks, the list name opening the list. Nothing at all
 * when no list links here, and no request for someone without customList:use.
 */

interface RequestInit {
  params?: { path?: Record<string, string> };
}

const linked = {
  lists: [
    {
      list: { id: "list-1", name_en: "Clinic visits", name_ar: "زيارات العيادة" },
      columns: [
        {
          id: "col-day",
          field_type: "date",
          label_en: "Visit day",
          label_ar: "يوم الزيارة",
          required: false,
          sensitivity: "standard",
          sort_order: 0,
          archived: false,
          options: [],
        },
        {
          id: "col-note",
          field_type: "long_text",
          label_en: "Diagnosis",
          label_ar: "التشخيص",
          required: false,
          sensitivity: "sensitive",
          sort_order: 1,
          archived: false,
          options: [],
        },
      ],
      rows: [
        {
          id: "row-1",
          link: { kind: "student", id: "student-1", name: "Amara Chen" },
          cells: [
            {
              column_id: "col-day",
              value: "2026-10-12T00:00:00.000Z",
              masked: false,
              mask: null,
            },
            { column_id: "col-note", value: null, masked: true, mask: "••••" },
          ],
          created_at: "2026-10-12T08:00:00.000Z",
          updated_at: "2026-10-12T08:00:00.000Z",
        },
      ],
      total: 3,
    },
  ],
};

let response: unknown = linked;
const getMock = mock((_path: string, _init?: RequestInit) =>
  Promise.resolve<unknown>({ data: response }),
);
mock.module("../../lib/api", () => ({ api: { GET: getMock } }));

async function renderPanel(roles: string[]) {
  const { LinkedListsPanel } = await import("./LinkedListsPanel");
  const store = await createTestSessionStore(roles);
  return render(
    <AuthProvider store={store}>
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <main>
            <LinkedListsPanel subject={{ kind: "student", id: "student-1" }} />
          </main>
        </MemoryRouter>
      </QueryClientProvider>
    </AuthProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
  response = linked;
});

describe("the Lists panel", () => {
  test("shows each linked list's rows, masking sensitive cells", async () => {
    const { container } = await renderPanel(["PRINCIPAL"]);
    const link = await screen.findByRole("link", { name: "Clinic visits" });
    expect(link.getAttribute("href")).toBe("/portal/lists/list-1");
    expect(screen.getByText("2026-10-12")).toBeTruthy();
    expect(screen.getByText("••••")).toBeTruthy();
    expect(screen.getByText("and 2 more rows in this list")).toBeTruthy();
    const [path, init] = getMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/custom-lists/linked/{subjectKind}/{subjectId}");
    expect(init.params?.path).toEqual({ subjectKind: "student", subjectId: "student-1" });
    await expectNoA11yViolations(container);
  });

  test("renders nothing when no list links here", async () => {
    response = { lists: [] };
    const { container } = await renderPanel(["PRINCIPAL"]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getMock).toHaveBeenCalledTimes(1);
    expect(container.querySelector("section")).toBeNull();
  });

  test("asks nothing for a parent, who never sees lists", async () => {
    const { container } = await renderPanel(["PARENT"]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getMock).not.toHaveBeenCalled();
    expect(container.querySelector("section")).toBeNull();
  });
});
