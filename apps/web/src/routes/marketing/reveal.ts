import type { CSSProperties } from "react";

/**
 * Marks an element to rise into place when it first scrolls into view (layouts/marketing/
 * use-reveal.ts). `index` staggers siblings: each waits a little longer than the one before.
 */
export function reveal(index = 0): { "data-reveal": ""; style: CSSProperties } {
  return { "data-reveal": "", style: { "--reveal-index": index } as CSSProperties };
}
