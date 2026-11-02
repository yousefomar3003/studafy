import { forwardRef, useEffect, useId, useRef } from "react";

import { cx } from "../../internal/cx";
import { mergeRefs } from "../../internal/merge-refs";

import type { InputHTMLAttributes } from "react";

export interface CheckboxProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "className" | "type"
> {
  label: string;
  /** Renders the mixed state. The browser exposes this as `aria-checked="mixed"`. */
  indeterminate?: boolean;
  error?: string;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, indeterminate = false, error, id, disabled, ...rest },
  ref,
) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const errorId = `${inputId}-error`;
  const innerRef = useRef<HTMLInputElement>(null);

  // `indeterminate` exists only as a DOM property — there is no matching HTML attribute — so it
  // has to be written to the node after every render that can change it.
  useEffect(() => {
    if (innerRef.current) {
      innerRef.current.indeterminate = indeterminate;
    }
  }, [indeterminate]);

  return (
    <div className={cx("sf-field", disabled && "sf-field--disabled")}>
      <div className="sf-checkbox">
        <input
          {...rest}
          ref={mergeRefs(innerRef, ref)}
          type="checkbox"
          id={inputId}
          disabled={disabled}
          className={cx("sf-checkbox__control", error && "sf-checkbox__control--invalid")}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
        />
        <label className="sf-checkbox__label" htmlFor={inputId}>
          {label}
        </label>
      </div>

      {error ? (
        <p className="sf-field__error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
});
