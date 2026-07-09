import { useCallback, useEffect, useRef, useState } from "react";

import { cx } from "../../internal/cx";
import { useControllableState } from "../../internal/use-controllable-state";
import { computeVirtualRange } from "../../internal/virtual-range";
import { TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from "../table";

import type { CSSProperties, ReactNode, UIEvent } from "react";

export type DataGridAlign = "start" | "center" | "end";

export interface DataGridColumn<TRow> {
  /** Stable identifier. Used as the React key and as the sort key. */
  id: string;
  header: ReactNode;
  renderCell: (row: TRow) => ReactNode;
  sortable?: boolean;
  /** CSS column width, e.g. `120` or `"20%"`. Unset columns share remaining space. */
  width?: number | string;
  align?: DataGridAlign;
}

export type DataGridSortDirection = "asc" | "desc";

export interface DataGridSort {
  columnId: string;
  direction: DataGridSortDirection;
}

export interface DataGridProps<TRow> {
  /** Accessible name for the grid and its scroll region. */
  caption: string;
  columns: readonly DataGridColumn<TRow>[];
  /** The current page of rows. Sorting and pagination are the caller's responsibility — see the
   * `sort` and `useCursorPagination` docs. */
  rows: readonly TRow[];
  /** Stable per-row identifier, used for React keys and the selection set. */
  getRowId: (row: TRow) => string;
  /** Accessible label for a row's selection checkbox, e.g. `(row) => row.name`. */
  getRowLabel?: (row: TRow) => string;

  /** Height of every row in pixels. Must match the rendered row height for virtualization to stay
   * correct; cell content is clipped to a single line to guarantee it. Defaults to `44`, which
   * matches Table's own cell padding and line height. */
  rowHeight?: number;
  /** Height of the scrollable viewport in pixels. Defaults to `480`. */
  height?: number;
  /** Rows rendered outside the viewport on each side, to absorb fast scrolling. Defaults to `8`. */
  overscan?: number;

  /** Sortable columns emit this; the grid never reorders `rows` itself. Re-fetch or re-sort your
   * data in response, the same way you would after a page change. */
  sort?: DataGridSort | null;
  defaultSort?: DataGridSort | null;
  onSortChange?: (sort: DataGridSort | null) => void;

  /** Renders a checkbox column. Selection covers only the currently loaded `rows` — across pages
   * of a paginated grid, "select all" is the caller's concept, not the grid's. */
  selectable?: boolean;
  selectedRowIds?: ReadonlySet<string>;
  defaultSelectedRowIds?: ReadonlySet<string>;
  onSelectedRowIdsChange?: (rowIds: ReadonlySet<string>) => void;

  loading?: boolean;
  empty?: ReactNode;
}

const EMPTY_SELECTION: ReadonlySet<string> = new Set();

function nextSort<TRow>(
  current: DataGridSort | null,
  column: DataGridColumn<TRow>,
): DataGridSort | null {
  if (!current || current.columnId !== column.id) {
    return { columnId: column.id, direction: "asc" };
  }
  return current.direction === "asc" ? { columnId: column.id, direction: "desc" } : null;
}

function ariaSortFor(
  columnId: string,
  sort: DataGridSort | null,
): "ascending" | "descending" | "none" {
  if (!sort || sort.columnId !== columnId) {
    return "none";
  }
  return sort.direction === "asc" ? "ascending" : "descending";
}

function cellStyle(align: DataGridAlign | undefined): CSSProperties | undefined {
  return align && align !== "start" ? { textAlign: align } : undefined;
}

/**
 * A dense, virtualized table. Real `<table>` semantics (composed from Table's primitives) rather
 * than an ARIA grid pattern: fixed row heights make a windowed `<tbody>` with two spacer rows a
 * correct and much simpler substitute for measuring every row.
 *
 * Sorting is UI state only — clicking a sortable header updates the indicator and calls
 * `onSortChange`, but the grid never reorders `rows`. Combined with cursor pagination, sorting is
 * necessarily server-driven: a client-side sort could only ever be correct within one loaded page.
 */
export function DataGrid<TRow>({
  caption,
  columns,
  rows,
  getRowId,
  getRowLabel,
  rowHeight = 44,
  height = 480,
  overscan = 8,
  sort,
  defaultSort = null,
  onSortChange,
  selectable = false,
  selectedRowIds,
  defaultSelectedRowIds = EMPTY_SELECTION,
  onSelectedRowIdsChange,
  loading = false,
  empty,
}: DataGridProps<TRow>) {
  const [resolvedSort, setSort] = useControllableState<DataGridSort | null>({
    value: sort,
    defaultValue: defaultSort,
    onChange: onSortChange,
  });
  const [resolvedSelection, setSelection] = useControllableState<ReadonlySet<string>>({
    value: selectedRowIds,
    defaultValue: defaultSelectedRowIds,
    onChange: onSelectedRowIdsChange,
  });

  const [scrollTop, setScrollTop] = useState(0);
  const handleScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    setScrollTop(event.currentTarget.scrollTop);
  }, []);

  // `height` approximates the visible row area — it does not subtract the sticky header's own
  // height — which is safe because `overscan` pads both ends past the exact viewport math.
  const { startIndex, endIndex, topSpacerHeight, bottomSpacerHeight } = computeVirtualRange({
    rowCount: rows.length,
    rowHeight,
    viewportHeight: height,
    scrollTop,
    overscan,
  });

  const rowIds = rows.map(getRowId);
  const selectedCount = rowIds.filter((id) => resolvedSelection.has(id)).length;
  const allSelected = rowIds.length > 0 && selectedCount === rowIds.length;
  const someSelected = selectedCount > 0 && !allSelected;

  const selectAllRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someSelected;
    }
  }, [someSelected]);

  const toggleRow = (rowId: string) => {
    setSelection((current) => {
      const next = new Set(current);
      if (next.has(rowId)) {
        next.delete(rowId);
      } else {
        next.add(rowId);
      }
      return next;
    });
  };

  const toggleAll = () => {
    setSelection((current) => {
      const next = new Set(current);
      for (const id of rowIds) {
        if (allSelected) {
          next.delete(id);
        } else {
          next.add(id);
        }
      }
      return next;
    });
  };

  const columnCount = columns.length + (selectable ? 1 : 0);

  const bodyRows = rows.slice(startIndex, endIndex).map((row) => {
    const rowId = getRowId(row);
    const selected = resolvedSelection.has(rowId);

    return (
      <TableRow key={rowId} aria-selected={selectable ? selected : undefined}>
        {selectable ? (
          <TableCell>
            <input
              type="checkbox"
              className="sf-data-grid__select-checkbox"
              checked={selected}
              aria-label={getRowLabel ? `Select ${getRowLabel(row)}` : "Select row"}
              onChange={() => toggleRow(rowId)}
            />
          </TableCell>
        ) : null}
        {columns.map((column) => (
          <TableCell key={column.id} style={cellStyle(column.align)}>
            {column.renderCell(row)}
          </TableCell>
        ))}
      </TableRow>
    );
  });

  const topSpacer =
    topSpacerHeight > 0 ? (
      <tr aria-hidden="true" key="__top-spacer">
        <td colSpan={columnCount} style={{ height: topSpacerHeight, padding: 0, border: "none" }} />
      </tr>
    ) : null;
  const bottomSpacer =
    bottomSpacerHeight > 0 ? (
      <tr aria-hidden="true" key="__bottom-spacer">
        <td
          colSpan={columnCount}
          style={{ height: bottomSpacerHeight, padding: 0, border: "none" }}
        />
      </tr>
    ) : null;

  const bodyChildren = rows.length === 0 ? null : [topSpacer, ...bodyRows, bottomSpacer];

  return (
    <div className="sf-data-grid">
      <div
        className="sf-data-grid__scroll"
        role="region"
        aria-label={caption}
        tabIndex={0}
        style={
          {
            height,
            "--sf-data-grid-row-height": `${rowHeight}px`,
          } as CSSProperties
        }
        onScroll={handleScroll}
      >
        <table className="sf-table">
          <caption className="sf-table__caption">{caption}</caption>
          <colgroup>
            {selectable ? <col style={{ width: 48 }} /> : null}
            {columns.map((column) => (
              <col
                key={column.id}
                style={column.width !== undefined ? { width: column.width } : undefined}
              />
            ))}
          </colgroup>
          <TableHeader>
            <TableRow>
              {selectable ? (
                <TableHeaderCell>
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    className="sf-data-grid__select-checkbox"
                    checked={allSelected}
                    aria-label="Select all rows"
                    onChange={toggleAll}
                  />
                </TableHeaderCell>
              ) : null}
              {columns.map((column) => (
                <TableHeaderCell
                  key={column.id}
                  aria-sort={column.sortable ? ariaSortFor(column.id, resolvedSort) : undefined}
                  style={cellStyle(column.align)}
                >
                  {column.sortable ? (
                    <button
                      type="button"
                      className="sf-data-grid__sort-button"
                      onClick={() => setSort((current) => nextSort(current, column))}
                    >
                      <span>{column.header}</span>
                      <svg
                        className={cx(
                          "sf-data-grid__sort-icon",
                          resolvedSort?.columnId === column.id &&
                            `sf-data-grid__sort-icon--${resolvedSort.direction}`,
                        )}
                        width="10"
                        height="10"
                        viewBox="0 0 10 10"
                        aria-hidden="true"
                        focusable="false"
                      >
                        <path d="M5 2l3 4H2z" fill="currentColor" />
                      </svg>
                    </button>
                  ) : (
                    column.header
                  )}
                </TableHeaderCell>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody columnCount={columnCount} loading={loading} empty={empty}>
            {bodyChildren}
          </TableBody>
        </table>
      </div>
    </div>
  );
}
