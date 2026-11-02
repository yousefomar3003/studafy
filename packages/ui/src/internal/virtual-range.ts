export interface VirtualRangeOptions {
  rowCount: number;
  rowHeight: number;
  viewportHeight: number;
  scrollTop: number;
  /** Extra rows rendered beyond the viewport on each side, to absorb fast scrolling. */
  overscan?: number;
}

export interface VirtualRange {
  /** First rendered row index, inclusive. */
  startIndex: number;
  /** Last rendered row index, exclusive. */
  endIndex: number;
  /** Height of the spacer standing in for the rows above `startIndex`. */
  topSpacerHeight: number;
  /** Height of the spacer standing in for the rows at and after `endIndex`. */
  bottomSpacerHeight: number;
}

/**
 * Fixed-row-height windowing shared by DataGrid: only rows near the viewport are ever mounted,
 * and two spacers stand in for the rest so the scrollbar still reflects the full row count.
 *
 * A pure function rather than a hook so the math is directly testable without rendering — the
 * hook wrapper only needs to track `scrollTop` in state.
 */
export function computeVirtualRange({
  rowCount,
  rowHeight,
  viewportHeight,
  scrollTop,
  overscan = 8,
}: VirtualRangeOptions): VirtualRange {
  if (rowCount === 0 || rowHeight <= 0) {
    return { startIndex: 0, endIndex: 0, topSpacerHeight: 0, bottomSpacerHeight: 0 };
  }

  const visibleCount = Math.ceil(viewportHeight / rowHeight);
  const firstVisible = Math.floor(scrollTop / rowHeight);

  const startIndex = Math.max(0, firstVisible - overscan);
  const endIndex = Math.min(rowCount, firstVisible + visibleCount + overscan);

  return {
    startIndex,
    endIndex,
    topSpacerHeight: startIndex * rowHeight,
    bottomSpacerHeight: (rowCount - endIndex) * rowHeight,
  };
}
