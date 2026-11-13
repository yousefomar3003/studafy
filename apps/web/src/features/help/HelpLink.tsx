import type { ReactNode } from "react";

/**
 * Inline contextual help link: a question-mark icon plus link text. Used by the onboarding wizard
 * steps and the feature pages so every documented screen links back to its article.
 */
export function HelpLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <a href={to} className="help-link">
      <svg
        className="help-link__icon"
        width="14"
        height="14"
        viewBox="0 0 14 14"
        aria-hidden="true"
        focusable="false"
      >
        <circle cx="7" cy="7" r="6" fill="none" stroke="currentColor" strokeWidth="1.2" />
        <path
          d="M5.3 5.5a1.8 1.8 0 1 1 2.5 1.7c-.5.3-.8.6-.8 1.1"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
        />
        <circle cx="7" cy="10.3" r="0.8" fill="currentColor" />
      </svg>
      <span>{children}</span>
    </a>
  );
}
