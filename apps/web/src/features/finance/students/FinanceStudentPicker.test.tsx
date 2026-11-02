import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { useState } from "react";

import type { StudentIdentity } from "./FinanceStudentPicker";
import type { ComponentType } from "react";

const getMock = mock((_path: string, _init?: { params: { query: { search: string } } }) =>
  Promise.resolve({
    data: {
      students: [
        { id: "s-1", name: "Adam Fares", admission_number: "A-1" },
        { id: "s-2", name: "Lina Haddad", admission_number: "A-2" },
      ],
    },
  }),
);

mock.module("../../../lib/api", () => ({ api: { GET: getMock } }));

const loadPicker = async () => (await import("./FinanceStudentPicker")).FinanceStudentPicker;

async function renderPicker(onOuterKeyDown = () => undefined) {
  const Picker = await loadPicker();
  function Harness() {
    const [selected, setSelected] = useState<StudentIdentity[]>([]);
    return (
      // Stands in for a dialog that closes on Escape.
      <div onKeyDown={(event) => event.key === "Escape" && onOuterKeyDown()}>
        <Picker label="Student" selected={selected} onChange={setSelected} />
        <button type="button">Elsewhere</button>
      </div>
    );
  }
  const Wrapped: ComponentType = Harness;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <Wrapped />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
});

describe("FinanceStudentPicker", () => {
  test("the arrow opens the whole list and a press outside closes it", async () => {
    await renderPicker();

    fireEvent.click(screen.getByRole("button", { name: "Show students" }));
    expect(await screen.findByRole("option", { name: "Adam Fares" })).toBeTruthy();
    expect(getMock.mock.calls[0]?.[1]?.params.query.search).toBe("");

    fireEvent.pointerDown(screen.getByRole("button", { name: "Elsewhere" }));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  test("Escape closes the list without reaching the surrounding dialog", async () => {
    const outer = mock(() => undefined);
    await renderPicker(outer);

    const field = screen.getByRole("combobox", { name: "Student" });
    fireEvent.click(field);
    await screen.findByRole("listbox");

    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(outer).not.toHaveBeenCalled();
  });

  test("the list sits after the input, and picking a name selects it by name only", async () => {
    await renderPicker();
    const field = screen.getByRole("combobox", { name: "Student" });
    fireEvent.click(field);
    const list = await screen.findByRole("listbox");
    expect(field.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(await screen.findByRole("option", { name: "Lina Haddad" }));
    expect(screen.getByText("Lina Haddad")).toBeTruthy();
    expect(screen.queryByText("A-2")).toBeNull();
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
