import { Link } from "react-router-dom";

import { useDisclosure } from "../../layouts/portal/use-disclosure";
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

/**
 * A trailing arrow some shortcut labels carry in their translation ("Grades →", "الدرجات ←"). A
 * group's list is already a list of destinations, so it is dropped there.
 */
const TRAILING_ARROW = /\s*[→←]\s*$/u;

export interface ShortcutGroup {
  key: string;
  label: string;
  links: readonly { key: string; to: string; label: string }[];
}

/**
 * A home's shortcuts, sorted into a few named groups on one line, each opening a short list of its
 * links. Every role home with shortcuts uses it (admin, principal, finance). Each group is a
 * non-modal disclosure (useDisclosure): Escape closes it and returns focus to its button, a click
 * outside closes it, and the list holds ordinary links, so it is not an ARIA menu. A group left
 * with no links (every one filtered out by permission) is not shown.
 */
export function HomeShortcutGroups({ groups }: { groups: readonly ShortcutGroup[] }) {
  const { t } = useTranslation();
  const shown = groups.filter((group) => group.links.length > 0);
  if (shown.length === 0) return null;
  return (
    <nav className="home-shortcuts" aria-labelledby="home-shortcuts-heading">
      {/* Named for screen readers only: on screen the groups sit right under the page title. */}
      <h2 id="home-shortcuts-heading" className="sf-visually-hidden">
        {t("home.shortcuts")}
      </h2>
      <ul className="home-shortcut-groups">
        {shown.map((group) => (
          <li key={group.key}>
            <ShortcutGroupMenu group={group} />
          </li>
        ))}
      </ul>
    </nav>
  );
}

function ShortcutGroupMenu({ group }: { group: ShortcutGroup }) {
  const { open, toggle, close, triggerRef, panelRef } = useDisclosure();
  const panelId = `home-shortcut-group-${group.key}`;
  return (
    <div className="home-shortcut-group">
      <button
        ref={triggerRef}
        type="button"
        className="home-shortcut-group__trigger"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={toggle}
      >
        {group.label}
        <span className="home-shortcut-group__count">{group.links.length}</span>
        <svg
          className="home-shortcut-group__chevron"
          width="12"
          height="12"
          viewBox="0 0 12 12"
          aria-hidden="true"
          focusable="false"
        >
          <path
            d="M2.5 4.5 6 8l3.5-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open ? (
        <div id={panelId} ref={panelRef} className="home-shortcut-group__panel">
          <ul className="home-shortcut-group__list">
            {group.links.map((link) => (
              <li key={link.key}>
                <Link to={link.to} className="home-shortcut-group__link" onClick={close}>
                  {link.label.replace(TRAILING_ARROW, "")}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
