import type { MutableRefObject, Ref, RefCallback } from "react";

/**
 * Fans one node out to several refs. Needed wherever a component keeps an internal ref *and*
 * forwards one to the caller — Checkbox has to reach the DOM node to set `.indeterminate`, but
 * must still honour a forwarded ref.
 */
export function mergeRefs<T>(...refs: (Ref<T> | undefined)[]): RefCallback<T> {
  return (node) => {
    for (const ref of refs) {
      if (typeof ref === "function") {
        ref(node);
      } else if (ref) {
        (ref as MutableRefObject<T | null>).current = node;
      }
    }
  };
}
