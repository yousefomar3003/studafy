import { useMemo, useState } from "react";

import { Chip } from "../chip";

import { DataGrid } from "./data-grid";
import { useCursorPagination } from "./use-cursor-pagination";

import type { DataGridColumn, DataGridSort } from "./data-grid";
import type { CursorPage } from "./use-cursor-pagination";
import type { Meta, StoryObj } from "@storybook/react-vite";

const meta: Meta<typeof DataGrid> = {
  title: "Components/DataGrid",
  component: DataGrid,
  tags: ["autodocs"],
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "A dense, virtualized table built on Table's primitives. Sortable columns only emit " +
          "`onSortChange` — the grid never reorders rows itself, since that has to be server-driven " +
          "once cursor pagination is involved.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof DataGrid>;

interface Enrollment {
  id: string;
  student: string;
  course: string;
  attempts: number;
  score: number;
}

function makeEnrollments(count: number): Enrollment[] {
  const courses = ["Algebra", "Geometry", "Calculus", "Statistics"];
  return Array.from({ length: count }, (_, index) => ({
    id: `enrollment-${index}`,
    student: `Student ${index}`,
    course: courses[index % courses.length],
    attempts: (index % 3) + 1,
    score: (index * 7) % 101,
  }));
}

const columns: DataGridColumn<Enrollment>[] = [
  {
    id: "student",
    header: "Student",
    renderCell: (row) => row.student,
    sortable: true,
    width: 200,
  },
  { id: "course", header: "Course", renderCell: (row) => row.course, sortable: true, width: 160 },
  {
    id: "attempts",
    header: "Attempts",
    renderCell: (row) => row.attempts,
    align: "end",
    width: 100,
  },
  {
    id: "score",
    header: "Score",
    renderCell: (row) => `${row.score}%`,
    sortable: true,
    align: "end",
    width: 100,
  },
];

const rows = makeEnrollments(50);

export const Default: Story = {
  render: () => (
    <DataGrid caption="Enrollments" columns={columns} rows={rows} getRowId={(row) => row.id} />
  ),
};

/** 1,000 rows, but only the rows near the viewport are ever mounted. Scroll to see the window shift. */
export const Virtualized1000Rows: Story = {
  render: () => {
    const manyRows = useMemo(() => makeEnrollments(1000), []);
    return (
      <DataGrid
        caption="Enrollments"
        columns={columns}
        rows={manyRows}
        getRowId={(row) => row.id}
      />
    );
  },
};

export const Sortable: Story = {
  render: () => {
    const [sort, setSort] = useState<DataGridSort | null>(null);
    const sortedRows = useMemo(() => {
      if (!sort) {
        return rows;
      }
      const factor = sort.direction === "asc" ? 1 : -1;
      return [...rows].sort((a, b) => {
        switch (sort.columnId) {
          case "student":
            return factor * a.student.localeCompare(b.student);
          case "course":
            return factor * a.course.localeCompare(b.course);
          case "score":
            return factor * (a.score - b.score);
          default:
            return 0;
        }
      });
    }, [sort]);

    return (
      <DataGrid
        caption="Enrollments"
        columns={columns}
        rows={sortedRows}
        getRowId={(row) => row.id}
        sort={sort}
        onSortChange={setSort}
      />
    );
  },
};

export const Selectable: Story = {
  render: () => {
    const [selectedRowIds, setSelectedRowIds] = useState<ReadonlySet<string>>(new Set());
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {[...selectedRowIds].map((id) => (
            <Chip
              key={id}
              onRemove={() =>
                setSelectedRowIds((current) => {
                  const next = new Set(current);
                  next.delete(id);
                  return next;
                })
              }
            >
              {rows.find((row) => row.id === id)?.student}
            </Chip>
          ))}
        </div>
        <DataGrid
          caption="Enrollments"
          columns={columns}
          rows={rows.slice(0, 10)}
          getRowId={(row) => row.id}
          getRowLabel={(row) => row.student}
          selectable
          selectedRowIds={selectedRowIds}
          onSelectedRowIdsChange={setSelectedRowIds}
        />
      </div>
    );
  },
};

export const Loading: Story = {
  render: () => (
    <DataGrid
      caption="Enrollments"
      columns={columns}
      rows={[]}
      getRowId={(row) => row.id}
      loading
    />
  ),
};

export const Empty: Story = {
  render: () => (
    <DataGrid
      caption="Enrollments"
      columns={columns}
      rows={[]}
      getRowId={(row) => row.id}
      empty="No enrollments match your filters."
    />
  ),
};

export const DarkTheme: Story = { ...Default, globals: { theme: "dark" } };

/**
 * `useCursorPagination` against a fake API shaped like `{ items, nextCursor }` — the same shape
 * `apps/api` cursor-paginated routes return. Fetching, not sorting, drives what page you are on.
 */
export const WithCursorPagination: Story = {
  render: () => {
    const allRows = useMemo(() => makeEnrollments(45), []);
    const pageSize = 10;

    const fetchPage = useMemo(
      () =>
        (cursor: string | undefined): Promise<CursorPage<Enrollment>> => {
          const start = cursor ? Number(cursor) : 0;
          const end = start + pageSize;
          const items = allRows.slice(start, end);
          const nextCursor = end < allRows.length ? String(end) : undefined;
          return new Promise((resolve) => setTimeout(() => resolve({ items, nextCursor }), 300));
        },
      [allRows],
    );

    const { items, loading, hasNextPage, hasPreviousPage, goToNextPage, goToPreviousPage } =
      useCursorPagination(fetchPage);

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <DataGrid
          caption="Enrollments"
          columns={columns}
          rows={items}
          getRowId={(row) => row.id}
          loading={loading}
          height={10 * 44}
        />
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" disabled={!hasPreviousPage} onClick={goToPreviousPage}>
            Previous
          </button>
          <button type="button" disabled={!hasNextPage} onClick={goToNextPage}>
            Next
          </button>
        </div>
      </div>
    );
  },
};
