import { forwardRef } from "react";

import { cx } from "../../internal/cx";

import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from "react";

export interface TableProps extends Omit<HTMLAttributes<HTMLTableElement>, "className"> {
  /** Accessible name for the table and its scroll region. */
  caption: string;
  /** Visually hide the caption while keeping it available to assistive technology. */
  hideCaption?: boolean;
}

const TableRoot = forwardRef<HTMLTableElement, TableProps>(function Table(
  { caption, hideCaption = false, children, ...rest },
  ref,
) {
  return (
    // A wide table must be scrollable, and a scrollable region must be reachable by keyboard —
    // hence the labelled, focusable wrapper rather than a bare `overflow: auto` div.
    <div className="sf-table__scroll" role="region" aria-label={caption} tabIndex={0}>
      <table {...rest} ref={ref} className="sf-table">
        <caption className={cx("sf-table__caption", hideCaption && "sf-visually-hidden")}>
          {caption}
        </caption>
        {children}
      </table>
    </div>
  );
});

export type TableSectionProps = Omit<HTMLAttributes<HTMLTableSectionElement>, "className">;

export const TableHeader = forwardRef<HTMLTableSectionElement, TableSectionProps>(
  function TableHeader(props, ref) {
    return <thead {...props} ref={ref} className="sf-table__header" />;
  },
);

export interface TableBodyProps extends TableSectionProps {
  /** Replaces the rows with a busy placeholder. */
  loading?: boolean;
  /** Rendered when there are no rows and the table is not loading. */
  empty?: ReactNode;
  /** Column count, used to span the loading and empty placeholders. */
  columnCount: number;
}

export const TableBody = forwardRef<HTMLTableSectionElement, TableBodyProps>(function TableBody(
  { loading = false, empty, columnCount, children, ...rest },
  ref,
) {
  const hasRows = Boolean(children) && (!Array.isArray(children) || children.length > 0);

  if (loading) {
    return (
      <tbody {...rest} ref={ref} className="sf-table__body" aria-busy="true">
        <tr>
          <td colSpan={columnCount} className="sf-table__placeholder">
            {/* Announced politely; the skeleton itself is decorative. */}
            <span className="sf-visually-hidden" role="status">
              Loading
            </span>
            <span className="sf-table__skeleton" aria-hidden="true" />
            <span className="sf-table__skeleton" aria-hidden="true" />
            <span className="sf-table__skeleton" aria-hidden="true" />
          </td>
        </tr>
      </tbody>
    );
  }

  if (!hasRows) {
    return (
      <tbody {...rest} ref={ref} className="sf-table__body">
        <tr>
          <td colSpan={columnCount} className="sf-table__placeholder">
            {empty ?? "No results."}
          </td>
        </tr>
      </tbody>
    );
  }

  return (
    <tbody {...rest} ref={ref} className="sf-table__body">
      {children}
    </tbody>
  );
});

export const TableFooter = forwardRef<HTMLTableSectionElement, TableSectionProps>(
  function TableFooter(props, ref) {
    return <tfoot {...props} ref={ref} className="sf-table__footer" />;
  },
);

export type TableRowProps = Omit<HTMLAttributes<HTMLTableRowElement>, "className">;

export const TableRow = forwardRef<HTMLTableRowElement, TableRowProps>(
  function TableRow(props, ref) {
    return <tr {...props} ref={ref} className="sf-table__row" />;
  },
);

export interface TableHeaderCellProps extends Omit<
  ThHTMLAttributes<HTMLTableCellElement>,
  "className"
> {
  /** Defaults to `col`; use `row` for a row header. */
  scope?: "col" | "row";
}

export const TableHeaderCell = forwardRef<HTMLTableCellElement, TableHeaderCellProps>(
  function TableHeaderCell({ scope = "col", ...rest }, ref) {
    return <th {...rest} ref={ref} scope={scope} className="sf-table__header-cell" />;
  },
);

export type TableCellProps = Omit<TdHTMLAttributes<HTMLTableCellElement>, "className">;

export const TableCell = forwardRef<HTMLTableCellElement, TableCellProps>(
  function TableCell(props, ref) {
    return <td {...props} ref={ref} className="sf-table__cell" />;
  },
);

export const Table = Object.assign(TableRoot, {
  Header: TableHeader,
  Body: TableBody,
  Footer: TableFooter,
  Row: TableRow,
  HeaderCell: TableHeaderCell,
  Cell: TableCell,
});
