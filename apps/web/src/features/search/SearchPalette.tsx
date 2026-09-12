import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { useTranslation } from "../../lib/i18n";

import { GLOBAL_SEARCH_MIN_QUERY_LENGTH, useGlobalSearchQuery } from "./queries";
import { addRecentSearch, clearRecentSearches, loadRecentSearches } from "./recent-searches";
import { buildResultGroups, isNavigable } from "./result-groups";

import type { GlobalSearchResult } from "./queries";
import type { NavigableSearchResultItem } from "./result-groups";
import type { KeyboardEvent } from "react";

const SEARCH_DEBOUNCE_MS = 300;

type PaletteRow =
  | { kind: "recent"; id: string; term: string }
  | { kind: "result"; id: string; item: NavigableSearchResultItem };

function joinClassNames(...values: (string | false | undefined)[]): string {
  return values.filter(Boolean).join(" ");
}

export interface SearchPaletteProps {
  onClose: () => void;
}

/**
 * The palette's own content, mounted fresh every time the surrounding `Modal` opens (its parent,
 * `GlobalSearchTrigger`, only renders this while `open` is true) -- so every field below starts
 * from its initial value each time, with no reset effect needed.
 *
 * Combobox pattern: focus stays on the `<input>` the whole time; arrow keys move a virtual
 * selection (`aria-activedescendant`) through a `role="listbox"` below it. This is the ARIA APG
 * "listbox popup" pattern, the same shape whether the popup floats under an inline field or -- as
 * here -- fills a dialog.
 */
export function SearchPalette({ onClose }: SearchPaletteProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const inputId = useId();
  const listboxId = useId();

  const inputRef = useRef<HTMLInputElement>(null);
  const rowElements = useRef<Map<string, HTMLDivElement>>(new Map());

  const [rawQuery, setRawQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [recentSearches, setRecentSearches] = useState<string[]>(() => loadRecentSearches());

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedQuery(rawQuery), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [rawQuery]);

  const trimmedQuery = debouncedQuery.trim();
  const mode: "recent" | "hint" | "results" =
    trimmedQuery.length === 0
      ? "recent"
      : trimmedQuery.length < GLOBAL_SEARCH_MIN_QUERY_LENGTH
        ? "hint"
        : "results";

  const searchQuery = useGlobalSearchQuery(trimmedQuery);

  const groups = useMemo(
    // The generated response type loses its array shape a level deep here -- the same pre-existing
    // `@studafy/api-client` typing gap `NotificationBell.tsx` documents for a top-level list. The
    // cast restores it without widening to `any`; the actual JSON shape is exactly `GlobalSearchResult`.
    () =>
      mode === "results" && searchQuery.data
        ? buildResultGroups(searchQuery.data as GlobalSearchResult)
        : [],
    [mode, searchQuery.data],
  );

  const rows: PaletteRow[] = useMemo(() => {
    if (mode === "recent") {
      return recentSearches.map((term) => ({
        kind: "recent" as const,
        id: `recent:${term}`,
        term,
      }));
    }
    if (mode === "results") {
      return groups.flatMap((group) =>
        group.items
          .filter(isNavigable)
          .map((item) => ({ kind: "result" as const, id: item.key, item })),
      );
    }
    return [];
  }, [mode, recentSearches, groups]);

  useEffect(() => {
    setActiveIndex(0);
  }, [mode, trimmedQuery]);

  useEffect(() => {
    const activeRow = rows[activeIndex];
    if (!activeRow) return;
    rowElements.current.get(activeRow.id)?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, rows]);

  function registerRow(id: string) {
    return (element: HTMLDivElement | null) => {
      if (element) rowElements.current.set(id, element);
      else rowElements.current.delete(id);
    };
  }

  function activateRow(row: PaletteRow) {
    if (row.kind === "recent") {
      setRawQuery(row.term);
      setDebouncedQuery(row.term);
      inputRef.current?.focus();
      return;
    }
    setRecentSearches(addRecentSearch(trimmedQuery));
    onClose();
    navigate(row.item.href);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (rows.length === 0) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActiveIndex((current) => (current + 1) % rows.length);
        break;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex((current) => (current - 1 + rows.length) % rows.length);
        break;
      case "Home":
        event.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        event.preventDefault();
        setActiveIndex(rows.length - 1);
        break;
      case "Enter": {
        event.preventDefault();
        const row = rows[activeIndex];
        if (row) activateRow(row);
        break;
      }
      default:
        break;
    }
  }

  function handleClearRecent() {
    clearRecentSearches();
    setRecentSearches([]);
  }

  const activeRowId = rows[activeIndex]?.id;

  return (
    <div className="search-palette">
      <div className="search-palette__input-row">
        <label htmlFor={inputId} className="sf-visually-hidden">
          {t("globalSearch.inputLabel")}
        </label>
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={listboxId}
          aria-activedescendant={activeRowId}
          aria-autocomplete="list"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          className="search-palette__input"
          placeholder={t("globalSearch.placeholder")}
          value={rawQuery}
          onChange={(event) => setRawQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>

      <div
        id={listboxId}
        role="listbox"
        aria-label={t("globalSearch.resultsLabel")}
        className="search-palette__results"
      >
        {mode === "recent" ? (
          recentSearches.length === 0 ? (
            <p className="search-palette__empty">{t("globalSearch.recentEmpty")}</p>
          ) : (
            <div role="group" aria-labelledby={`${listboxId}-recent`}>
              <div className="search-palette__group-heading-row">
                <p id={`${listboxId}-recent`} className="search-palette__group-heading">
                  {t("globalSearch.recentHeading")}
                </p>
                <button
                  type="button"
                  className="search-palette__clear-recent"
                  onClick={handleClearRecent}
                >
                  {t("globalSearch.clearRecent")}
                </button>
              </div>
              {recentSearches.map((term) => {
                const id = `recent:${term}`;
                const active = id === activeRowId;
                return (
                  <div
                    key={id}
                    id={id}
                    ref={registerRow(id)}
                    role="option"
                    aria-selected={active}
                    className={joinClassNames(
                      "search-palette__item",
                      active && "search-palette__item--active",
                    )}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => activateRow({ kind: "recent", id, term })}
                  >
                    <span className="search-palette__item-title">{term}</span>
                  </div>
                );
              })}
            </div>
          )
        ) : mode === "hint" ? (
          <p className="search-palette__empty">{t("globalSearch.minLengthHint")}</p>
        ) : searchQuery.isPending ? (
          <p role="status" className="search-palette__empty">
            {t("globalSearch.loading")}
          </p>
        ) : searchQuery.isError ? (
          <p role="alert" className="search-palette__empty">
            {t("globalSearch.error")}
          </p>
        ) : groups.length === 0 ? (
          <p className="search-palette__empty">
            {t("globalSearch.noResults", { query: trimmedQuery })}
          </p>
        ) : (
          groups.map((group) => {
            const headingId = `${listboxId}-${group.type}`;
            return (
              <div key={group.type} role="group" aria-labelledby={headingId}>
                <p id={headingId} className="search-palette__group-heading">
                  {t(`globalSearch.groups.${group.type}`)}
                </p>
                {group.items.map((item) => {
                  const navigableItem = isNavigable(item) ? item : null;
                  const active = navigableItem !== null && item.key === activeRowId;
                  return (
                    <div
                      key={item.key}
                      id={navigableItem ? item.key : undefined}
                      ref={navigableItem ? registerRow(item.key) : undefined}
                      role={navigableItem ? "option" : "presentation"}
                      aria-selected={navigableItem ? active : undefined}
                      aria-disabled={navigableItem ? undefined : true}
                      title={navigableItem ? undefined : t("globalSearch.noDetailPage")}
                      className={joinClassNames(
                        "search-palette__item",
                        active && "search-palette__item--active",
                        !navigableItem && "search-palette__item--disabled",
                      )}
                      onMouseDown={navigableItem ? (event) => event.preventDefault() : undefined}
                      onClick={
                        navigableItem
                          ? () => activateRow({ kind: "result", id: item.key, item: navigableItem })
                          : undefined
                      }
                    >
                      <span className="search-palette__item-title">{item.title}</span>
                      <span className="search-palette__item-subtitle">{item.subtitle}</span>
                    </div>
                  );
                })}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
