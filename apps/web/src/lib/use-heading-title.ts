import { useEffect } from "react";

import type { RefObject } from "react";

const SITE_NAME = "Studafy";

/** The page's own name: its first h1, without decorations marked aria-hidden (icons, badges). */
export function headingTitle(root: ParentNode): string {
  const heading = root.querySelector("h1");
  if (!heading) return "";
  const copy = heading.cloneNode(true) as HTMLElement;
  for (const hidden of copy.querySelectorAll("[aria-hidden='true']")) hidden.remove();
  return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** "Approvals | Studafy", or just "Studafy" while the page has no heading yet. */
export function documentTitleFor(heading: string): string {
  return heading ? `${heading} | ${SITE_NAME}` : SITE_NAME;
}

/**
 * Names the browser tab after the page on screen — "Approvals | Studafy" — by reading the page's
 * h1 inside `rootRef`. Every page already has one, translated, so the tab follows the language
 * too. Watching the DOM rather than the URL means a heading that arrives with its data (a
 * student's name) or changes in place (switching an Academic setup tab) updates the tab as well.
 */
export function useHeadingTitle(rootRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;

    let frame = 0;
    const update = () => {
      frame = 0;
      const title = documentTitleFor(headingTitle(root));
      if (document.title !== title) document.title = title;
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(update);
    };

    update();
    const observer = new MutationObserver(schedule);
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
      document.title = SITE_NAME;
    };
  }, [rootRef]);
}
