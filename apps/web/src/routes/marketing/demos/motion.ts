import { useEffect, useState } from "react";

import type { RefObject } from "react";

/** True when the visitor has asked their system for reduced motion. */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

/**
 * Whether the element is on screen. Without IntersectionObserver (old browsers, unit tests) it is
 * never reported as visible, so nothing that waits on it ever starts on its own.
 */
export function useInView(ref: RefObject<Element | null>, threshold = 0.35): boolean {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => setInView(entry?.isIntersecting ?? false),
      {
        threshold,
      },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, threshold]);
  return inView;
}
