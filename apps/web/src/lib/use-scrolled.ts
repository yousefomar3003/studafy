import { useEffect, useLayoutEffect, useState } from "react";
import { useLocation } from "react-router-dom";

/** Scroll distance (px) past which a shell header detaches into its floating pill. */
const SCROLLED_OFFSET = 8;

/**
 * Attribute marking a shell's scroll container. The window itself never scrolls: each shell scrolls
 * a region below its header (so the scrollbar starts under the header, not beside it) and tags that
 * region with this attribute.
 */
export const SCROLL_ROOT_ATTR = "data-scroll-root";

/**
 * True once the shell's scroll container has scrolled past `SCROLLED_OFFSET`. Scroll events don't
 * bubble, so this listens in the capture phase on the document and reads whichever
 * `[data-scroll-root]` scrolled — headers stay decoupled from the region their layout scrolls.
 * Shared by every shell header (marketing, portal, root nav), which expose it as `data-scrolled`.
 */
export function useScrolled(): boolean {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const update = (event: Event) => {
      const target = event.target;
      if (target instanceof Element && target.hasAttribute(SCROLL_ROOT_ATTR)) {
        setScrolled(target.scrollTop > SCROLLED_OFFSET);
      }
    };
    document.addEventListener("scroll", update, { capture: true, passive: true });
    return () => document.removeEventListener("scroll", update, { capture: true });
  }, []);
  return scrolled;
}

/**
 * Starts every newly chosen page at its top. The window never scrolls, so the browser's own reset
 * doesn't apply: on each pathname change this rewinds every `[data-scroll-root]` instead. A link
 * with a `#fragment` (e.g. `/about#contact`, from any page or the same one) lands on its target
 * instead; pages that render it later (HelpArticlePage) handle it themselves.
 *
 * Call it from inside the route `Suspense` boundary, not above it. A first visit to a lazy page
 * suspends the boundary, which hides the whole shell (`display: none`) while the chunk loads; a
 * hidden scroll region ignores `scrollTo` and the browser restores its old offset on reveal. Inside
 * the boundary, this commits together with the new page, once the region is visible again.
 */
export function useScrollToTopOnNavigate(): void {
  const { pathname, hash } = useLocation();
  // Layout effect: rewind before paint, so the new page never flashes at the old offset.
  useLayoutEffect(() => {
    if (hash) {
      document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView({
        block: "start",
      });
      return;
    }
    for (const root of document.querySelectorAll(`[${SCROLL_ROOT_ATTR}]`)) {
      root.scrollTo({ top: 0, left: 0 });
    }
    // The hash is tracked too, so a same-page anchor link ("Talk to us" on /about) still lands.
  }, [pathname, hash]);
}

/** Renders nothing; mounts `useScrollToTopOnNavigate` inside a `Suspense` boundary. */
export function ScrollToTopOnNavigate(): null {
  useScrollToTopOnNavigate();
  return null;
}
