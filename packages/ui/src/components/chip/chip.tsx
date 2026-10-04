import { forwardRef } from "react";

import { cx } from "../../internal/cx";
import { useUiStrings } from "../../internal/ui-strings";

import type { HTMLAttributes } from "react";

export type ChipVariant = "filled" | "outlined";

export interface ChipProps extends Omit<HTMLAttributes<HTMLSpanElement>, "className"> {
  variant?: ChipVariant;
  disabled?: boolean;
  /** When provided, renders a remove button. The chip itself stays non-interactive. */
  onRemove?: () => void;
  /** Accessible name for the remove button. Include the chip's text — "Remove" alone is ambiguous. */
  removeLabel?: string;
}

export const Chip = forwardRef<HTMLSpanElement, ChipProps>(function Chip(
  { variant = "filled", disabled = false, onRemove, removeLabel, children, ...rest },
  ref,
) {
  const strings = useUiStrings();
  return (
    <span
      {...rest}
      ref={ref}
      data-disabled={disabled || undefined}
      className={cx("sf-chip", `sf-chip--${variant}`, disabled && "sf-chip--disabled")}
    >
      <span className="sf-chip__label">{children}</span>

      {onRemove ? (
        <button
          type="button"
          className="sf-chip__remove"
          disabled={disabled}
          aria-label={
            removeLabel ??
            (typeof children === "string" ? strings.removeChip(children) : strings.removeItem)
          }
          onClick={onRemove}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
            <path
              d="M3 3l6 6M9 3l-6 6"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      ) : null}
    </span>
  );
});
