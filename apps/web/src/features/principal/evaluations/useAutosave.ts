import { useEffect, useRef, useState } from "react";

export type AutosaveStatus = "idle" | "saving" | "saved" | "error";

export interface UseAutosaveOptions<T> {
  value: T;
  onSave: (value: T) => Promise<unknown>;
  /** Debounce window, restarted on every `value` change. */
  delayMs?: number;
  /** Compares `value` against the last successfully saved value. Defaults to `Object.is`, which is
   * only correct for primitives — pass a field-by-field comparator for object values (see
   * `EvaluationDetailPage.tsx`'s notes form and `ScoreRow`). */
  isEqual?: (a: T, b: T) => boolean;
  /** Skips saving entirely, e.g. while the field is invalid or the record is read-only. */
  enabled?: boolean;
}

const DEFAULT_DELAY_MS = 1000;

/**
 * Debounced autosave for a controlled field or small field group. Fires `onSave` `delayMs` after
 * `value` last changed, and skips the call when `value` already matches what was last saved —
 * including on mount, since callers seed their local state from the loaded record rather than an
 * empty default (see `EvaluationWorkspace`'s `useState(() => toNotesForm(evaluation))`), so the
 * initial render never looks dirty.
 *
 * No debounce/autosave primitive existed anywhere in this codebase before this evaluation form
 * needed one; kept local to `evaluations/` rather than promoted to `lib/` since it has one caller
 * so far.
 */
export function useAutosave<T>({
  value,
  onSave,
  delayMs = DEFAULT_DELAY_MS,
  isEqual = Object.is,
  enabled = true,
}: UseAutosaveOptions<T>): AutosaveStatus {
  const [status, setStatus] = useState<AutosaveStatus>("idle");
  const savedRef = useRef(value);
  const onSaveRef = useRef(onSave);
  const isEqualRef = useRef(isEqual);
  onSaveRef.current = onSave;
  isEqualRef.current = isEqual;

  useEffect(() => {
    if (!enabled || isEqualRef.current(value, savedRef.current)) return;

    setStatus("saving");
    const timeout = window.setTimeout(() => {
      onSaveRef
        .current(value)
        .then(() => {
          savedRef.current = value;
          setStatus("saved");
        })
        .catch(() => setStatus("error"));
    }, delayMs);

    return () => window.clearTimeout(timeout);
    // onSave/isEqual are read through refs above so a new function identity each render doesn't
    // retrigger the debounce timer — only an actual `value`, `delayMs`, or `enabled` change should.
  }, [value, delayMs, enabled]);

  return status;
}
