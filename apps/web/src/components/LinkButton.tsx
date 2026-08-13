import { forwardRef } from "react";
import { Link } from "react-router-dom";

import type { ButtonVariant } from "@studafy/ui";
import type { AnchorHTMLAttributes } from "react";

export interface LinkButtonProps extends Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  "className"
> {
  href: string;
  variant?: ButtonVariant;
  fullWidth?: boolean;
}

/**
 * A link styled as `@studafy/ui`'s `Button` — same `.sf-button` classes, so it picks up every
 * theme/focus-ring/hover rule the component defines. `Button` itself always renders a `<button>`
 * (no polymorphic `as`), which is correct for actions but wrong for navigation: a "Sign in" or
 * "Talk to us" link needs to be a real `<a>` so it's a normal browser link (open in new tab,
 * ctrl-click, crawlable href) rather than a JS click handler standing in for one.
 *
 * Routes starting with "/" go through `react-router-dom`'s `Link` for client-side navigation;
 * anything else (mailto:, http(s)://) renders a plain anchor.
 */
export const LinkButton = forwardRef<HTMLAnchorElement, LinkButtonProps>(function LinkButton(
  { href, variant = "primary", fullWidth = false, children, ...rest },
  ref,
) {
  const className = ["sf-button", `sf-button--${variant}`, fullWidth ? "sf-button--full-width" : ""]
    .filter(Boolean)
    .join(" ");

  if (href.startsWith("/")) {
    return (
      <Link {...rest} ref={ref} to={href} className={className}>
        <span className="sf-button__label">{children}</span>
      </Link>
    );
  }

  return (
    <a {...rest} ref={ref} href={href} className={className}>
      <span className="sf-button__label">{children}</span>
    </a>
  );
});
