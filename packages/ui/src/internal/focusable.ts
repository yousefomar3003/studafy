const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not(:disabled)",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * Focusable descendants in tab order. Private to `useFocusTrap`.
 *
 * `hidden` and `[aria-hidden]` elements are excluded, but nothing here consults layout: happy-dom
 * reports every element as zero-sized, and a trap that trusted `getBoundingClientRect` would find
 * no candidates at all under test.
 */
export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.hasAttribute("hidden") && element.getAttribute("aria-hidden") !== "true",
  );
}
