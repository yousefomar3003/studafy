import navyLogoUrl from "../assets/studafy-logo-navy.png";
import logoUrl from "../assets/studafy-logo.png";

import "./brand-logo.css";

export interface BrandLogoProps {
  /** `sm` for header bars, `lg` for standalone placements such as the sign-in card. */
  size?: "sm" | "lg";
  /**
   * `light` is the white wordmark made for the dark-blue headers; `navy` is the brand's own navy
   * wordmark for light surfaces such as the sign-in card.
   */
  tone?: "light" | "navy";
  /**
   * Sets the white wordmark on the brand's navy so it stays visible on a light surface. Has no
   * effect with `tone="navy"`, which is already legible there.
   */
  badge?: boolean;
}

/**
 * The Studafy wordmark. "Studafy" is a proper noun, so the alt text is never translated; links that
 * wrap the logo carry their own accessible name (e.g. `shell.homeLink`).
 */
export function BrandLogo({ size = "sm", tone = "light", badge = false }: BrandLogoProps) {
  const navy = tone === "navy";
  // Intrinsic size (the PNG's own) lets the browser reserve the box before the image arrives — no
  // layout shift in the header; CSS sets the rendered height and the width follows the ratio.
  const img = (
    <img
      src={navy ? navyLogoUrl : logoUrl}
      alt="Studafy"
      width={navy ? 387 : 388}
      height={120}
      className={`brand-logo brand-logo--${size}`}
    />
  );
  return badge && !navy ? <span className="brand-logo-badge">{img}</span> : img;
}
