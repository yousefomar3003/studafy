import { forwardRef, useId } from "react";

import { cx } from "../../internal/cx";

import type { InputHTMLAttributes, ReactNode } from "react";

export interface InputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "className" | "prefix"
> {
  label: string;
  helperText?: string;
  /** Message describing what is wrong. Its presence puts the field into the error state. */
  error?: string;
  prefix?: ReactNode;
  suffix?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, helperText, error, prefix, suffix, id, required, disabled, ...rest },
  ref,
) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const helperId = `${inputId}-helper`;
  const errorId = `${inputId}-error`;

  // Only reference ids that are actually rendered; a dangling aria-describedby is an axe violation.
  const describedBy =
    cx(helperText && helperId, error && errorId)
      .split(" ")
      .filter(Boolean)
      .join(" ") || undefined;

  return (
    <div className={cx("sf-field", disabled && "sf-field--disabled")}>
      <label className="sf-field__label" htmlFor={inputId}>
        {label}
        {required ? (
          <span className="sf-field__required" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>

      <div className={cx("sf-input", error && "sf-input--invalid")}>
        {prefix ? (
          <span className="sf-input__affix" aria-hidden="true">
            {prefix}
          </span>
        ) : null}
        <input
          {...rest}
          ref={ref}
          id={inputId}
          className="sf-input__control"
          required={required}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
        />
        {suffix ? (
          <span className="sf-input__affix" aria-hidden="true">
            {suffix}
          </span>
        ) : null}
      </div>

      {helperText ? (
        <p className="sf-field__helper" id={helperId}>
          {helperText}
        </p>
      ) : null}
      {error ? (
        <p className="sf-field__error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
});
