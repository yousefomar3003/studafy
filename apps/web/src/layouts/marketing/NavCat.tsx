/**
 * A pixel-art cat that walks around the outside of the marketing header. On the floating pill it
 * circles clockwise -- along the top, down the right end, upside-down along the underside, and up
 * the left end. It appears only once the visitor scrolls (the floating pill). Pure decoration: hidden
 * from assistive tech, never intercepts clicks, and sits still for visitors who prefer reduced
 * motion. All motion lives in marketing-shell.css (`.nav-cat*`).
 *
 * Drawn on a 10x7 grid, 2 CSS px per pixel, facing right with its feet on the bottom row; two leg
 * frames alternate to make it walk.
 */

/** [x, y, width] runs of filled pixels. */
type Run = readonly [number, number, number];

const BODY: readonly Run[] = [
  [6, 0, 1], // ears
  [9, 0, 1],
  [0, 1, 1], // tail tip
  [6, 1, 4], // head
  [1, 2, 1], // tail
  [6, 2, 4],
  [1, 3, 9], // back + head
  [2, 4, 7], // belly
  [2, 5, 1], // leg tops
  [4, 5, 1],
  [6, 5, 1],
  [8, 5, 1],
];
const FRAME_A: readonly Run[] = [
  [2, 6, 1],
  [6, 6, 1],
];
const FRAME_B: readonly Run[] = [
  [4, 6, 1],
  [8, 6, 1],
];

function pixels(runs: readonly Run[]) {
  return runs.map(([x, y, w]) => <rect key={`${x}-${y}`} x={x} y={y} width={w} height={1} />);
}

export function NavCat() {
  return (
    <div className="nav-cat" aria-hidden="true">
      <div className="nav-cat__walker">
        <svg
          className="nav-cat__sprite"
          width="20"
          height="14"
          viewBox="0 0 10 7"
          shapeRendering="crispEdges"
          focusable="false"
        >
          {pixels(BODY)}
          <g className="nav-cat__frame nav-cat__frame--a">{pixels(FRAME_A)}</g>
          <g className="nav-cat__frame nav-cat__frame--b">{pixels(FRAME_B)}</g>
          <rect className="nav-cat__eye" x={8} y={2} width={1} height={1} />
        </svg>
      </div>
    </div>
  );
}
