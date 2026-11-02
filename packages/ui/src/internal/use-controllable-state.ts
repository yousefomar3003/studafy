import { useCallback, useRef, useState } from "react";

export interface UseControllableStateOptions<T> {
  /** When provided, the component is controlled and this value always wins. */
  value?: T;
  /** Initial value when uncontrolled. Ignored once `value` is provided. */
  defaultValue: T;
  onChange?: (value: T) => void;
}

/**
 * The controlled/uncontrolled contract, in one place. A component reads the returned value
 * without caring which mode it is in, and calls the setter to request a change: when controlled,
 * that only notifies the parent; when uncontrolled, it also updates internal state.
 */
export function useControllableState<T>({
  value,
  defaultValue,
  onChange,
}: UseControllableStateOptions<T>): [T, (next: T | ((previous: T) => T)) => void] {
  const [uncontrolledValue, setUncontrolledValue] = useState<T>(defaultValue);
  const isControlled = value !== undefined;
  const resolvedValue = isControlled ? value : uncontrolledValue;

  // Kept in a ref so the returned setter stays referentially stable across renders.
  const latest = useRef({ isControlled, resolvedValue, onChange });
  latest.current = { isControlled, resolvedValue, onChange };

  const setValue = useCallback((next: T | ((previous: T) => T)) => {
    const current = latest.current;
    const resolved =
      typeof next === "function" ? (next as (previous: T) => T)(current.resolvedValue) : next;

    if (Object.is(resolved, current.resolvedValue)) {
      return;
    }
    if (!current.isControlled) {
      setUncontrolledValue(resolved);
    }
    current.onChange?.(resolved);
  }, []);

  return [resolvedValue, setValue];
}
