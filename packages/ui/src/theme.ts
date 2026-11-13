/**
 * Corporate Precision — canonical design tokens.
 *
 * This file is the single source of truth. `tokens.css` mirrors these values as CSS custom
 * properties; `tokens.consistency.test.ts` and `theme.contrast.test.ts` verify the CSS file and
 * the WCAG AA contrast of every text pair stay correct against this source.
 */

const colorBase = {
  white: "#FFFFFF",
  black: "#000000",
} as const;

// Cool-slate neutral scale — the structural backbone (surfaces, text, borders).
const neutral = {
  50: "#F8FAFC",
  100: "#F1F5F9",
  200: "#E2E8F0",
  300: "#CBD5E1",
  400: "#94A3B8",
  500: "#64748B",
  600: "#475569",
  700: "#334155",
  800: "#1E293B",
  900: "#0F172A",
  950: "#020617",
} as const;

// Precision blue — the single brand/action accent.
const accent = {
  50: "#EFF6FF",
  100: "#DBEAFE",
  200: "#BFDBFE",
  300: "#93C5FD",
  400: "#60A5FA",
  500: "#3B82F6",
  600: "#2563EB",
  700: "#1D4ED8",
  800: "#1E40AF",
  900: "#1E3A8A",
  950: "#172554",
} as const;

const success = {
  50: "#F0FDF4",
  100: "#DCFCE7",
  400: "#4ADE80",
  600: "#16A34A",
  700: "#15803D",
  800: "#166534",
} as const;

const danger = {
  50: "#FEF2F2",
  100: "#FEE2E2",
  400: "#F87171",
  600: "#DC2626",
  700: "#B91C1C",
  800: "#991B1B",
} as const;

const warning = {
  50: "#FFFBEB",
  100: "#FEF9C3",
  400: "#FACC15",
  700: "#A16207",
  800: "#854D0E",
} as const;

export const color = { ...colorBase, neutral, accent, success, danger, warning } as const;

/**
 * Theme-aware semantic aliases. Components should bind to these, never to `color.*` scale
 * steps directly, so a palette change only ever happens in one place.
 */
export const semanticColor = {
  light: {
    background: color.white,
    surface: color.neutral[50],
    foreground: color.neutral[900],
    mutedForeground: color.neutral[600],
    border: color.neutral[200],

    accent: color.accent[600],
    accentForeground: color.white,
    accentSubtleBg: color.accent[100],
    accentSubtleForeground: color.accent[800],

    success: color.success[700],
    successForeground: color.white,
    successSubtleBg: color.success[100],
    successSubtleForeground: color.success[800],

    danger: color.danger[600],
    dangerForeground: color.white,
    dangerSubtleBg: color.danger[100],
    dangerSubtleForeground: color.danger[800],

    warning: color.warning[700],
    warningForeground: color.white,
    warningSubtleBg: color.warning[100],
    warningSubtleForeground: color.warning[800],
  },
  dark: {
    background: color.neutral[950],
    surface: color.neutral[900],
    foreground: color.neutral[50],
    mutedForeground: color.neutral[400],
    border: color.neutral[700],

    accent: color.accent[400],
    accentForeground: color.neutral[950],
    accentSubtleBg: color.neutral[900],
    accentSubtleForeground: color.accent[400],

    success: color.success[400],
    successForeground: color.neutral[950],
    successSubtleBg: color.neutral[900],
    successSubtleForeground: color.success[400],

    danger: color.danger[400],
    dangerForeground: color.neutral[950],
    dangerSubtleBg: color.neutral[900],
    dangerSubtleForeground: color.danger[400],

    warning: color.warning[400],
    warningForeground: color.neutral[950],
    warningSubtleBg: color.neutral[900],
    warningSubtleForeground: color.warning[400],
  },
} as const;

export type ColorScheme = keyof typeof semanticColor;

/**
 * Text/background pairs that must meet WCAG AA. `minRatio` is 4.5 for normal text and 3 for
 * large text (>=24px, or >=19px bold) and non-text UI components, per WCAG 1.4.3 / 1.4.11.
 * Verified by theme.contrast.test.ts — do not add a pair here without a passing test.
 */
export const textContrastPairs: readonly {
  name: string;
  fg: string;
  bg: string;
  minRatio: number;
}[] = [
  {
    name: "light: foreground on background",
    fg: semanticColor.light.foreground,
    bg: semanticColor.light.background,
    minRatio: 4.5,
  },
  {
    name: "light: foreground on surface",
    fg: semanticColor.light.foreground,
    bg: semanticColor.light.surface,
    minRatio: 4.5,
  },
  {
    name: "light: muted-foreground on background",
    fg: semanticColor.light.mutedForeground,
    bg: semanticColor.light.background,
    minRatio: 4.5,
  },
  {
    name: "light: muted-foreground on surface",
    fg: semanticColor.light.mutedForeground,
    bg: semanticColor.light.surface,
    minRatio: 4.5,
  },
  {
    name: "light: accent-foreground on accent",
    fg: semanticColor.light.accentForeground,
    bg: semanticColor.light.accent,
    minRatio: 4.5,
  },
  {
    name: "light: accent-subtle-foreground on accent-subtle-bg",
    fg: semanticColor.light.accentSubtleForeground,
    bg: semanticColor.light.accentSubtleBg,
    minRatio: 4.5,
  },
  {
    name: "light: success-foreground on success",
    fg: semanticColor.light.successForeground,
    bg: semanticColor.light.success,
    minRatio: 4.5,
  },
  {
    name: "light: success-subtle-foreground on success-subtle-bg",
    fg: semanticColor.light.successSubtleForeground,
    bg: semanticColor.light.successSubtleBg,
    minRatio: 4.5,
  },
  {
    name: "light: danger-foreground on danger",
    fg: semanticColor.light.dangerForeground,
    bg: semanticColor.light.danger,
    minRatio: 4.5,
  },
  {
    name: "light: danger-subtle-foreground on danger-subtle-bg",
    fg: semanticColor.light.dangerSubtleForeground,
    bg: semanticColor.light.dangerSubtleBg,
    minRatio: 4.5,
  },
  {
    name: "light: warning-foreground on warning",
    fg: semanticColor.light.warningForeground,
    bg: semanticColor.light.warning,
    minRatio: 4.5,
  },
  {
    name: "light: warning-subtle-foreground on warning-subtle-bg",
    fg: semanticColor.light.warningSubtleForeground,
    bg: semanticColor.light.warningSubtleBg,
    minRatio: 4.5,
  },

  {
    name: "dark: foreground on background",
    fg: semanticColor.dark.foreground,
    bg: semanticColor.dark.background,
    minRatio: 4.5,
  },
  {
    name: "dark: foreground on surface",
    fg: semanticColor.dark.foreground,
    bg: semanticColor.dark.surface,
    minRatio: 4.5,
  },
  {
    name: "dark: muted-foreground on background",
    fg: semanticColor.dark.mutedForeground,
    bg: semanticColor.dark.background,
    minRatio: 4.5,
  },
  {
    name: "dark: muted-foreground on surface",
    fg: semanticColor.dark.mutedForeground,
    bg: semanticColor.dark.surface,
    minRatio: 4.5,
  },
  {
    name: "dark: accent-foreground on accent",
    fg: semanticColor.dark.accentForeground,
    bg: semanticColor.dark.accent,
    minRatio: 4.5,
  },
  {
    name: "dark: accent-subtle-foreground on accent-subtle-bg",
    fg: semanticColor.dark.accentSubtleForeground,
    bg: semanticColor.dark.accentSubtleBg,
    minRatio: 4.5,
  },
  {
    name: "dark: success-foreground on success",
    fg: semanticColor.dark.successForeground,
    bg: semanticColor.dark.success,
    minRatio: 4.5,
  },
  {
    name: "dark: success-subtle-foreground on success-subtle-bg",
    fg: semanticColor.dark.successSubtleForeground,
    bg: semanticColor.dark.successSubtleBg,
    minRatio: 4.5,
  },
  {
    name: "dark: danger-foreground on danger",
    fg: semanticColor.dark.dangerForeground,
    bg: semanticColor.dark.danger,
    minRatio: 4.5,
  },
  {
    name: "dark: danger-subtle-foreground on danger-subtle-bg",
    fg: semanticColor.dark.dangerSubtleForeground,
    bg: semanticColor.dark.dangerSubtleBg,
    minRatio: 4.5,
  },
  {
    name: "dark: warning-foreground on warning",
    fg: semanticColor.dark.warningForeground,
    bg: semanticColor.dark.warning,
    minRatio: 4.5,
  },
  {
    name: "dark: warning-subtle-foreground on warning-subtle-bg",
    fg: semanticColor.dark.warningSubtleForeground,
    bg: semanticColor.dark.warningSubtleBg,
    minRatio: 4.5,
  },
];

/**
 * Type scale. Inter is the brand typeface; consumers must load it themselves (e.g. via
 * `@fontsource/inter` or a self-hosted woff2) — tokens.css intentionally does not fetch a
 * remote stylesheet, since that would tie every consumer to a network request and Google's CDN.
 */
export const font = {
  family: {
    sans: '"Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    mono: 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace',
  },
  weight: {
    regular: 400,
    medium: 500,
    semibold: 600,
    bold: 700,
  },
  size: {
    xs: "0.75rem",
    sm: "0.875rem",
    base: "1rem",
    lg: "1.125rem",
    xl: "1.25rem",
    "2xl": "1.5rem",
    "3xl": "1.875rem",
    "4xl": "2.25rem",
    "5xl": "3rem",
  },
  lineHeight: {
    xs: "1rem",
    sm: "1.25rem",
    base: "1.5rem",
    lg: "1.75rem",
    xl: "1.75rem",
    "2xl": "2rem",
    "3xl": "2.25rem",
    "4xl": "2.5rem",
    "5xl": "1",
  },
  tracking: {
    tight: "-0.02em",
    snug: "-0.01em",
    normal: "0em",
  },
} as const;

/** 4px spacing scale. Token names are literal pixel values — no lookup table required. */
export const space = {
  0: "0px",
  4: "4px",
  8: "8px",
  12: "12px",
  16: "16px",
  20: "20px",
  24: "24px",
  32: "32px",
  40: "40px",
  48: "48px",
  64: "64px",
  80: "80px",
  96: "96px",
} as const;

export const radius = {
  none: "0px",
  sm: "4px",
  md: "8px",
  lg: "12px",
  xl: "16px",
  full: "9999px",
} as const;

/** Elevation is theme-aware: dark surfaces fake depth with opacity + a faint inset highlight. */
export const elevation = {
  light: {
    0: "none",
    1: "0 1px 2px rgba(2, 6, 23, 0.06), 0 1px 1px rgba(2, 6, 23, 0.04)",
    2: "0 2px 4px rgba(2, 6, 23, 0.08), 0 1px 2px rgba(2, 6, 23, 0.06)",
    3: "0 4px 8px rgba(2, 6, 23, 0.10), 0 2px 4px rgba(2, 6, 23, 0.06)",
    4: "0 8px 16px rgba(2, 6, 23, 0.12), 0 4px 8px rgba(2, 6, 23, 0.08)",
  },
  dark: {
    0: "none",
    1: "0 1px 2px rgba(0, 0, 0, 0.40), inset 0 1px 0 rgba(255, 255, 255, 0.03)",
    2: "0 2px 4px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.03)",
    3: "0 4px 8px rgba(0, 0, 0, 0.50), inset 0 1px 0 rgba(255, 255, 255, 0.04)",
    4: "0 8px 16px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.04)",
  },
} as const;

/**
 * Motion. Durations collapse to 1ms under `prefers-reduced-motion: reduce` (see tokens.css), so
 * components may transition freely without each one re-implementing the media query.
 */
export const motion = {
  duration: {
    fast: "120ms",
    base: "200ms",
    slow: "320ms",
  },
  easing: {
    standard: "cubic-bezier(0.2, 0, 0, 1)",
    emphasized: "cubic-bezier(0.3, 0, 0, 1)",
    exit: "cubic-bezier(0.4, 0, 1, 1)",
  },
} as const;

/** Stacking order for layered surfaces. Gaps of 100 leave room for app-level layers between. */
export const zIndex = {
  base: 0,
  dropdown: 1000,
  sticky: 1100,
  overlay: 1200,
  modal: 1300,
  toast: 1400,
  tooltip: 1500,
} as const;

/**
 * Focus ring geometry. The color is deliberately absent here: in CSS it aliases
 * `--color-accent`, which is already theme-aware, so the ring flips with dark mode for free.
 */
export const focusRing = {
  width: "2px",
  offset: "2px",
} as const;

export const theme = {
  color,
  semanticColor,
  font,
  space,
  radius,
  elevation,
  motion,
  zIndex,
  focusRing,
} as const;
