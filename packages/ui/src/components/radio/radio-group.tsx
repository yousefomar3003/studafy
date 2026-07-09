import { forwardRef, useId } from "react";

import { cx } from "../../internal/cx";
import { useControllableState } from "../../internal/use-controllable-state";

import { RadioGroupProvider } from "./radio-group-context";

import type { ReactNode } from "react";

export interface RadioGroupProps {
  label: string;
  /** Shared across the radios, which is what gives the group its native arrow-key navigation. */
  name: string;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  disabled?: boolean;
  required?: boolean;
  error?: string;
  children: ReactNode;
}

export const RadioGroup = forwardRef<HTMLFieldSetElement, RadioGroupProps>(function RadioGroup(
  { label, name, value, defaultValue, onChange, disabled = false, required, error, children },
  ref,
) {
  const groupId = useId();
  const errorId = `${groupId}-error`;

  const [selected, setSelected] = useControllableState<string | undefined>({
    value,
    defaultValue,
    onChange: onChange as ((value: string | undefined) => void) | undefined,
  });

  return (
    <fieldset
      ref={ref}
      className={cx("sf-radio-group", disabled && "sf-field--disabled")}
      disabled={disabled}
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? errorId : undefined}
      aria-required={required || undefined}
    >
      <legend className="sf-field__label">{label}</legend>

      <RadioGroupProvider
        value={{
          name,
          value: selected,
          onSelect: setSelected,
          disabled,
          invalid: Boolean(error),
          describedBy: error ? errorId : undefined,
        }}
      >
        <div className="sf-radio-group__items">{children}</div>
      </RadioGroupProvider>

      {error ? (
        <p className="sf-field__error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
});
