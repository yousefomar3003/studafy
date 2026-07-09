import { fireEvent, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, mock, test } from "bun:test";

import { expectNoA11yViolations } from "../../internal/test/axe";

import { DataGrid } from "./data-grid";

import type { DataGridColumn } from "./data-grid";

interface Student {
  id: string;
  name: string;
  score: number;
}

const students: Student[] = Array.from({ length: 20 }, (_, index) => ({
  id: `student-${index}`,
  name: `Student ${index}`,
  score: index,
}));

const columns: DataGridColumn<Student>[] = [
  { id: "name", header: "Name", renderCell: (row) => row.name, sortable: true },
  { id: "score", header: "Score", renderCell: (row) => row.score },
];

describe("DataGrid", () => {
  test("renders real table semantics with a caption and column headers", () => {
    render(
      <DataGrid caption="Students" columns={columns} rows={students} getRowId={(r) => r.id} />,
    );

    expect(screen.getByRole("table", { name: "Students" })).toBeDefined();
    expect(screen.getByRole("columnheader", { name: "Name" })).toBeDefined();
    expect(screen.getByRole("columnheader", { name: "Score" })).toBeDefined();
  });

  test("virtualizes: only rows near the viewport are mounted", () => {
    render(
      <DataGrid
        caption="Students"
        columns={columns}
        rows={students}
        getRowId={(r) => r.id}
        rowHeight={40}
        height={120}
        overscan={1}
      />,
    );

    expect(screen.getByText("Student 0")).toBeDefined();
    expect(screen.getByText("Student 3")).toBeDefined();
    expect(screen.queryByText("Student 10")).toBeNull();
  });

  test("scrolling shifts the rendered window", () => {
    const { container } = render(
      <DataGrid
        caption="Students"
        columns={columns}
        rows={students}
        getRowId={(r) => r.id}
        rowHeight={40}
        height={120}
        overscan={1}
      />,
    );
    const scrollRegion = container.querySelector(".sf-data-grid__scroll") as HTMLElement;

    fireEvent.scroll(scrollRegion, { target: { scrollTop: 400 } });

    expect(screen.getByText("Student 10")).toBeDefined();
    expect(screen.queryByText("Student 0")).toBeNull();
  });

  test("the scroll region names the grid, the same way Table names its own region", () => {
    render(
      <DataGrid caption="Students" columns={columns} rows={students} getRowId={(r) => r.id} />,
    );

    expect(screen.getByRole("region", { name: "Students" })).toBeDefined();
  });

  test("a sortable column starts with aria-sort=none and cycles on click", () => {
    render(
      <DataGrid caption="Students" columns={columns} rows={students} getRowId={(r) => r.id} />,
    );
    const nameHeader = screen.getByRole("columnheader", { name: "Name" });
    const sortButton = screen.getByRole("button", { name: "Name" });

    expect(nameHeader.getAttribute("aria-sort")).toBe("none");

    fireEvent.click(sortButton);
    expect(nameHeader.getAttribute("aria-sort")).toBe("ascending");

    fireEvent.click(sortButton);
    expect(nameHeader.getAttribute("aria-sort")).toBe("descending");

    fireEvent.click(sortButton);
    expect(nameHeader.getAttribute("aria-sort")).toBe("none");
  });

  test("a non-sortable column has no sort affordance", () => {
    render(
      <DataGrid caption="Students" columns={columns} rows={students} getRowId={(r) => r.id} />,
    );

    expect(
      screen.getByRole("columnheader", { name: "Score" }).getAttribute("aria-sort"),
    ).toBeNull();
  });

  test("clicking a sort button calls onSortChange with the new sort state", () => {
    const onSortChange = mock();
    render(
      <DataGrid
        caption="Students"
        columns={columns}
        rows={students}
        getRowId={(r) => r.id}
        onSortChange={onSortChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Name" }));

    expect(onSortChange).toHaveBeenCalledWith({ columnId: "name", direction: "asc" });
  });

  test("never reorders rows itself: sorting is purely a UI indicator", () => {
    render(
      <DataGrid
        caption="Students"
        columns={columns}
        rows={students}
        getRowId={(r) => r.id}
        rowHeight={40}
        height={120}
        overscan={1}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Name" }));

    // Still windowed from the top in the original row order.
    expect(screen.getByText("Student 0")).toBeDefined();
  });

  test("selectable renders one checkbox per row, falling back to a generic label", () => {
    const rows = students.slice(0, 3);
    const onSelectedRowIdsChange = mock();
    render(
      <DataGrid
        caption="Students"
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        selectable
        onSelectedRowIdsChange={onSelectedRowIdsChange}
      />,
    );
    const rowCheckboxes = screen.getAllByRole("checkbox", { name: "Select row" });

    expect(rowCheckboxes).toHaveLength(3);
    fireEvent.click(rowCheckboxes[0]);

    expect(onSelectedRowIdsChange).toHaveBeenCalledWith(new Set([rows[0].id]));
  });

  test("selecting one row leaves the header checkbox indeterminate", () => {
    const { container } = render(
      <DataGrid
        caption="Students"
        columns={columns}
        rows={students.slice(0, 3)}
        getRowId={(r) => r.id}
        getRowLabel={(row) => row.name}
        selectable
      />,
    );
    const rowCheckbox = screen.getByRole("checkbox", { name: "Select Student 0" });
    const headerCheckbox = container.querySelector(
      "thead .sf-data-grid__select-checkbox",
    ) as HTMLInputElement;

    fireEvent.click(rowCheckbox);

    expect(headerCheckbox.indeterminate).toBe(true);
    expect(headerCheckbox.checked).toBe(false);
  });

  test("the header checkbox selects and clears every loaded row", () => {
    const rows = students.slice(0, 3);
    const onSelectedRowIdsChange = mock();
    render(
      <DataGrid
        caption="Students"
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        getRowLabel={(row) => row.name}
        selectable
        onSelectedRowIdsChange={onSelectedRowIdsChange}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "Select all rows" }));

    expect(onSelectedRowIdsChange).toHaveBeenCalledWith(new Set(rows.map((r) => r.id)));
  });

  test("loading defers to Table's own busy placeholder", () => {
    render(
      <DataGrid caption="Students" columns={columns} rows={[]} getRowId={(r) => r.id} loading />,
    );

    expect(screen.getByRole("status").textContent).toBe("Loading");
  });

  test("empty defers to Table's own empty placeholder", () => {
    render(
      <DataGrid
        caption="Students"
        columns={columns}
        rows={[]}
        getRowId={(r) => r.id}
        empty="No students yet."
      />,
    );

    expect(screen.getByText("No students yet.")).toBeDefined();
  });

  test("has no accessibility violations", async () => {
    const { container } = render(
      <DataGrid
        caption="Students"
        columns={columns}
        rows={students.slice(0, 5)}
        getRowId={(r) => r.id}
        getRowLabel={(row) => row.name}
        selectable
      />,
    );

    await expectNoA11yViolations(container);
  });

  test("has no accessibility violations while loading", async () => {
    const { container } = render(
      <DataGrid caption="Students" columns={columns} rows={[]} getRowId={(r) => r.id} loading />,
    );

    await expectNoA11yViolations(container);
  });
});
