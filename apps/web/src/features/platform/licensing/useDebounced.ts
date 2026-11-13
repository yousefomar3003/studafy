import { useEffect, useState } from "react";

/** `value`, settled for `ms` -- so a search or the calculator acts on what was typed, not each key. */
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const handle = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(handle);
  }, [value, ms]);
  return settled;
}
