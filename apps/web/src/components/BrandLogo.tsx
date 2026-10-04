import logoUrl from "../assets/studafy-logo.png";

import "./brand-logo.css";

export interface BrandLogoProps {
  /** `sm` for header bars, `lg` for standalone placements such as the sign-in card. */
  size?: "sm" | "lg";
  /**
   * The wordmark is white on transparent, made for the dark-blue headers. On a light surface,
   * `badge` sets it on the brand's own navy so it stays visible.
   */
  badge?: boolean;
}

/**
 * The Studafy wordmark. "Studafy" is a proper noun, so the alt text is never translated; links that
 * wrap the logo carry their own accessible name (e.g. `shell.homeLink`).
 */
export function BrandLogo({ size = "sm", badge = false }: BrandLogoProps) {
  // Intrinsic size (the PNG's own) lets the browser reserve the box before the image arrives — no
  // layout shift in the header; CSS sets the rendered height and the width follows the ratio.
  const img = (
    <img
      src={logoUrl}
      alt="Studafy"
      width={388}
      height={120}
      className={`brand-logo brand-logo--${size}`}
    />
  );
  return badge ? <span className="brand-logo-badge">{img}</span> : img;
}
