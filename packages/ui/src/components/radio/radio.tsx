import { forwardRef, useId } from "react";

import { cx } from "../../internal/cx";

import { useRadioGroup } from "./radio-group-context";

import type { InputHTMLAttributes } from "react";

export interface RadioProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "className" | "type" | "name" | "value"
> {
  value: string;
  label: string;
}

export const Radio = forwardRef<HTMLInputElement, RadioProps>(function Radio(
  { value, label, id, disabled, ...rest },
  ref,
) {
  const group = useRadioGroup();
  const generatedId = useId();
  const inputId = id ?? generatedId;

  return (
    <div className="sf-radio">
      <input
        {...rest}
        ref={ref}
        type="radio"
        id={inputId}
        className={cx("sf-radio__control", group.invalid && "sf-radio__control--invalid")}
        name={group.name}
        value={value}
        checked={group.value === value}
        disabled={disabled || group.disabled}
        aria-describedby={group.describedBy}
        onChange={() => group.onSelect(value)}
      />
      <label className="sf-radio__label" htmlFor={inputId}>
        {label}
      </label>
    </div>
  );
});
