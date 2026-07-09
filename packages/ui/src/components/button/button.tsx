import { forwardRef } from "react";

import { cx } from "../../internal/cx";

import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "tertiary";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  variant?: ButtonVariant;
  /** Shows a spinner and blocks interaction. The label stays in the accessibility tree. */
  loading?: boolean;
  fullWidth?: boolean;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "primary",
    loading = false,
    fullWidth = false,
    leadingIcon,
    trailingIcon,
    disabled = false,
    type = "button",
    children,
    ...rest
  },
  ref,
) {
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      // A loading button is genuinely unavailable, so it is disabled rather than merely styled as
      // such — `aria-busy` is what tells assistive tech the state is temporary.
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      data-loading={loading || undefined}
      className={cx("sf-button", `sf-button--${variant}`, fullWidth && "sf-button--full-width")}
    >
      {loading ? <span className="sf-button__spinner" aria-hidden="true" /> : null}
      {leadingIcon ? (
        <span className="sf-button__icon" aria-hidden="true">
          {leadingIcon}
        </span>
      ) : null}
      <span className="sf-button__label">{children}</span>
      {trailingIcon ? (
        <span className="sf-button__icon" aria-hidden="true">
          {trailingIcon}
        </span>
      ) : null}
    </button>
  );
});
