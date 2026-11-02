import { Link } from "react-router-dom";

import { useTranslation } from "../../lib/i18n";

import type { DashboardTileStatus } from "../DashboardTile";

import "./home.css";

export interface SummaryItem {
  key: string;
  label: string;
  /** Already formatted for display. Ignored unless `status` is `"ready"`. */
  value: string;
  hint?: string;
  /** Where the number drills into. */
  to?: string;
  /** Marks a non-zero count that someone should act on. */
  attention?: boolean;
  status: DashboardTileStatus;
  /** Shown in place of `hint` when `status` is `"error"`. */
  errorMessage?: string;
}

/**
 * The row of headline numbers under a home page's title. Each figure loads on its own, like the
 * dashboard tiles: one failed endpoint shows a dash in its own cell and leaves the rest alone.
 */
export function SummaryStrip({ items }: { items: readonly SummaryItem[] }) {
  const { t } = useTranslation();

  return (
    <section className="home-summary" aria-label={t("home.summaryLabel")}>
      <ul className="home-summary__list">
        {items.map((item) => {
          const ready = item.status === "ready";
          const hint =
            item.status === "error"
              ? (item.errorMessage ?? t("home.unavailable"))
              : item.status === "pending"
                ? t("site.common.loading")
                : item.hint;
          const body = (
            <>
              <span className="home-summary__label">{item.label}</span>
              <span className="home-summary__value" data-muted={ready ? undefined : true}>
                {ready ? item.value : "—"}
              </span>
              {hint ? (
                <span
                  className="home-summary__hint"
                  data-error={item.status === "error" || undefined}
                >
                  {hint}
                </span>
              ) : null}
            </>
          );
          return (
            <li
              key={item.key}
              className="home-summary__item"
              data-attention={ready && item.attention ? true : undefined}
            >
              {item.to ? (
                <Link to={item.to} className="home-summary__cell home-summary__cell--link">
                  {body}
                </Link>
              ) : (
                <div className="home-summary__cell">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** A labelled group of related links, rendered as a compact grid. */
export function HomeShortcuts({
  links,
}: {
  links: readonly { key: string; to: string; label: string }[];
}) {
  const { t } = useTranslation();
  return (
    <nav className="home-shortcuts" aria-labelledby="home-shortcuts-heading">
      <h2 id="home-shortcuts-heading" className="home-section-heading">
        {t("home.shortcuts")}
      </h2>
      <ul className="home-shortcuts__list">
        {links.map((link) => (
          <li key={link.key}>
            <Link to={link.to} className="home-shortcuts__link">
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
