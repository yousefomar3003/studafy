import { useLayoutEffect } from "react";

import type { RefObject } from "react";

/**
 * Lets marketing content rise into place the first time it scrolls into view: every element marked
 * `data-reveal` under `root` gets `data-revealed="true"` once it is in view, and the CSS
 * (marketing-pages.css) moves it the last few pixels into place. A one-off settle, never a loop,
 * and nothing that drifts or hovers.
 *
 * The root only gets `data-reveal-ready` once this is running, and only for visitors who have not
 * asked for reduced motion, so without IntersectionObserver (old browsers, unit tests) or with
 * reduced motion everything simply shows. Lazy routes render after a navigation, so new elements
 * are picked up as they are added.
 */
export function useReveal(root: RefObject<HTMLElement | null>): void {
  // A layout effect: the root is marked before the first paint, so content never shows and then
  // disappears to animate in.
  useLayoutEffect(() => {
    const scrollRoot = root.current;
    if (!scrollRoot || typeof IntersectionObserver === "undefined") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

    const intersection = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.setAttribute("data-revealed", "true");
          intersection.unobserve(entry.target);
        }
      },
      { root: scrollRoot, rootMargin: "0px 0px -8% 0px", threshold: 0.12 },
    );

    const watch = () => {
      for (const element of scrollRoot.querySelectorAll("[data-reveal]:not([data-revealed])")) {
        intersection.observe(element);
      }
    };

    const mutations = new MutationObserver(watch);
    mutations.observe(scrollRoot, { childList: true, subtree: true });
    watch();
    scrollRoot.setAttribute("data-reveal-ready", "");

    return () => {
      mutations.disconnect();
      intersection.disconnect();
      scrollRoot.removeAttribute("data-reveal-ready");
    };
  }, [root]);
}
