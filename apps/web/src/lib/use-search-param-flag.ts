import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";

/**
 * Reads a "do this on arrival" query parameter — `?create=1` opens a page's create modal, `?invite=1`
 * focuses its invite form — and hands back a `clear` that drops it again. The global search's "Do"
 * results (`features/search/destinations.ts`) link to these, and so can anyone: pasting the URL
 * does the same thing as picking the action.
 *
 * `clear` replaces the history entry rather than pushing one, so once the modal is closed, Back
 * goes to the previous page instead of reopening it. Every other query parameter is kept.
 */
export function useSearchParamFlag(name: string): [value: string | null, clear: () => void] {
  const [params, setParams] = useSearchParams();
  const value = params.get(name);
  const clear = useCallback(() => {
    setParams(
      (previous) => {
        if (!previous.has(name)) return previous;
        const next = new URLSearchParams(previous);
        next.delete(name);
        return next;
      },
      { replace: true },
    );
  }, [name, setParams]);
  return [value, clear];
}
