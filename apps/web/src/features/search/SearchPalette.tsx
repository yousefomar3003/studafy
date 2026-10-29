import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { useAuth, usePermissions } from "../../lib/auth";
import { useTranslation } from "../../lib/i18n";

import {
  destinationById,
  loadSearchDestinationCatalogs,
  searchTranslators,
  suggestedActions,
} from "./destinations";
import { buildLocalGroups, closestDestinations, destinationItem } from "./palette-groups";
import { GLOBAL_SEARCH_MIN_QUERY_LENGTH, useGlobalSearchQuery } from "./queries";
import { addRecentSearch, clearRecentSearches, loadRecentSearches } from "./recent-searches";
import { buildResultGroups } from "./result-groups";
import { parseScopedQuery, searchResultsHref } from "./scoped-query";

import type { HelpSearch, PaletteItem } from "./palette-groups";
import type { KeyboardEvent } from "react";

const SEARCH_DEBOUNCE_MS = 300;

/** One headed block of rows. `items` without an `href` render read-only and are skipped by keys. */
interface PaletteSection {
  id: string;
  heading: string;
  items: PaletteItem[];
  /** Extra action beside the heading (only "Clear" on recent searches). */
  onClear?: () => void;
}

type PaletteRow =
  { kind: "recent"; id: string; term: string } | { kind: "link"; id: string; href: string };

function joinClassNames(...values: (string | false | undefined)[]): string {
  return values.filter(Boolean).join(" ");
}

/** DOM ids must not contain the spaces or `#`/`?` a key may carry. */
function optionId(listboxId: string, key: string): string {
  return `${listboxId}-${key.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

export interface SearchPaletteProps {
  onClose: () => void;
}

/**
 * The palette's own content, mounted fresh every time the surrounding `Modal` opens (its parent,
 * `GlobalSearchTrigger`, only renders this while `open` is true) -- so every field below starts
 * from its initial value each time, with no reset effect needed.
 *
 * Results come in two speeds (docs/modules/search.md "The palette"): "Go to", "Do" and "How to" are
 * ranked on the client from the destinations registry and the help catalogue on every keystroke;
 * record groups follow from `GET /api/search` after a 300 ms pause. Both only ever offer what this
 * session can open -- hiding is not security, the route and API guards stay the real gate.
 *
 * Combobox pattern: focus stays on the `<input>` the whole time; arrow keys move a virtual
 * selection (`aria-activedescendant`) through a `role="listbox"` below it (ARIA APG "listbox
 * popup"), with each group a `role="group"` labelled by its heading.
 */
export function SearchPalette({ onClose }: SearchPaletteProps) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const permissions = usePermissions();
  const { roles } = useAuth();
  const inputId = useId();
  const listboxId = useId();

  const inputRef = useRef<HTMLInputElement>(null);
  const rowElements = useRef<Map<string, HTMLDivElement>>(new Map());

  const [rawQuery, setRawQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [recentSearches, setRecentSearches] = useState<string[]>(() => loadRecentSearches());
  const [catalogsReady, setCatalogsReady] = useState(false);
  const [searchHelp, setSearchHelp] = useState<HelpSearch | undefined>(undefined);

  // The registry's strings (every language it matches in) and the help catalogue load when the
  // palette opens, on whichever portal page that is -- neither is in the entry bundle.
  useEffect(() => {
    let live = true;
    loadSearchDestinationCatalogs()
      .catch(() => undefined)
      .finally(() => {
        if (live) setCatalogsReady(true);
      });
    import("../help/articles")
      .then((help) => {
        if (live) setSearchHelp(() => help.searchHelp);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedQuery(rawQuery), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [rawQuery]);

  const instant = parseScopedQuery(rawQuery);
  const debounced = parseScopedQuery(debouncedQuery);
  const recordsEnabled = debounced.text.length >= GLOBAL_SEARCH_MIN_QUERY_LENGTH;
  const searchQuery = useGlobalSearchQuery(recordsEnabled ? debounced.text : "", {
    type: debounced.type,
  });
  const arabic = i18n.language.startsWith("ar");

  const sections: PaletteSection[] = useMemo(() => {
    const text = instant.text;
    const translators = catalogsReady ? searchTranslators(i18n.language) : [];

    if (text.length === 0 && !instant.type) {
      const blocks: PaletteSection[] = [];
      if (recentSearches.length > 0) {
        blocks.push({
          id: "recent",
          heading: t("globalSearch.recentHeading"),
          items: recentSearches.map((term) => ({ key: `recent:${term}`, title: term })),
          onClear: () => {
            clearRecentSearches();
            setRecentSearches([]);
          },
        });
      }
      if (catalogsReady) {
        const suggestions = suggestedActions(permissions)
          .map((id) => destinationById(id))
          .filter((destination) => destination !== undefined)
          .map((destination) => destinationItem(destination, t));
        if (suggestions.length > 0) {
          blocks.push({
            id: "suggested",
            heading: t("globalSearch.suggestedHeading"),
            items: suggestions,
          });
        }
      }
      return blocks;
    }

    const blocks: PaletteSection[] = [];
    // `in:<type>` narrows to one record type, so the instant groups step aside.
    if (!instant.type && catalogsReady) {
      for (const group of buildLocalGroups(text, {
        permissions,
        roles,
        t,
        translators,
        arabic,
        searchHelp,
      })) {
        blocks.push({
          id: group.id,
          heading: t(`globalSearch.groups.${group.id}`),
          items: group.items,
        });
      }
    }

    // Records only for the query the API actually answered, so a stale result never sits under a
    // newer query's instant groups.
    const answered = searchQuery.data && searchQuery.data.query === debounced.text;
    if (recordsEnabled && answered && debounced.text === text && debounced.type === instant.type) {
      for (const group of buildResultGroups(searchQuery.data!, permissions, t)) {
        const items = [...group.items];
        if (group.total > group.items.length) {
          items.push({
            key: `see-all:${group.type}`,
            title: t("globalSearch.seeAll", { count: group.total }),
            href: searchResultsHref(text, group.type),
          });
        }
        blocks.push({ id: group.type, heading: t(`globalSearch.groups.${group.type}`), items });
      }
    }
    return blocks;
  }, [
    instant.text,
    instant.type,
    debounced.text,
    debounced.type,
    recordsEnabled,
    searchQuery.data,
    recentSearches,
    catalogsReady,
    searchHelp,
    permissions,
    roles,
    arabic,
    i18n.language,
    t,
  ]);

  const recordsSettled =
    !recordsEnabled ||
    (debounced.text === instant.text && !searchQuery.isFetching && !searchQuery.isPending);
  const typing = instant.text.length > 0 || instant.type !== undefined;
  const nothingFound = typing && sections.length === 0 && recordsSettled && catalogsReady;

  // "No results": the help center, plus the registry entries closest to what was typed.
  const fallbackSection: PaletteSection | null = useMemo(() => {
    if (!nothingFound) return null;
    const closest = closestDestinations(instant.text, {
      permissions,
      translators: searchTranslators(i18n.language),
    }).map((destination) => destinationItem(destination, t));
    return {
      id: "fallback",
      heading: t("globalSearch.tryInstead"),
      items: [
        ...closest,
        { key: "help-center", title: t("globalSearch.helpCenter"), href: "/help" },
      ],
    };
  }, [nothingFound, instant.text, permissions, i18n.language, t]);

  const shown = fallbackSection ? [fallbackSection] : sections;

  const rows: PaletteRow[] = useMemo(
    () =>
      shown.flatMap((section) =>
        section.items.flatMap((item): PaletteRow[] => {
          const id = optionId(listboxId, item.key);
          if (section.id === "recent") return [{ kind: "recent", id, term: item.title }];
          return item.href ? [{ kind: "link", id, href: item.href }] : [];
        }),
      ),
    [shown, listboxId],
  );

  const rowsSignature = rows.map((row) => row.id).join("|");
  useEffect(() => {
    setActiveIndex(0);
  }, [rowsSignature]);

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
    if (rawQuery.trim()) setRecentSearches(addRecentSearch(rawQuery.trim()));
    onClose();
    navigate(row.href);
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

  const activeRowId = rows[activeIndex]?.id;
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const recordsLoading = typing && recordsEnabled && !recordsSettled && !searchQuery.isError;

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
        {!typing && shown.length === 0 ? (
          <p className="search-palette__empty">{t("globalSearch.recentEmpty")}</p>
        ) : null}
        {nothingFound ? (
          <p className="search-palette__empty">
            {t("globalSearch.noResults", { query: rawQuery.trim() })}
          </p>
        ) : null}

        {shown.map((section) => {
          const headingId = `${listboxId}-${section.id}-heading`;
          return (
            <div key={section.id} role="group" aria-labelledby={headingId}>
              <div className="search-palette__group-heading-row">
                <p id={headingId} className="search-palette__group-heading">
                  {section.heading}
                </p>
                {section.onClear ? (
                  <button
                    type="button"
                    className="search-palette__clear-recent"
                    onClick={section.onClear}
                  >
                    {t("globalSearch.clearRecent")}
                  </button>
                ) : null}
              </div>
              {section.items.map((item) => {
                const id = optionId(listboxId, item.key);
                const row = rowById.get(id);
                const active = row !== undefined && id === activeRowId;
                return (
                  <div
                    key={item.key}
                    id={row ? id : undefined}
                    ref={row ? registerRow(id) : undefined}
                    role={row ? "option" : "presentation"}
                    aria-selected={row ? active : undefined}
                    aria-disabled={row ? undefined : true}
                    title={row ? undefined : t("globalSearch.noDetailPage")}
                    className={joinClassNames(
                      "search-palette__item",
                      active && "search-palette__item--active",
                      !row && "search-palette__item--disabled",
                      item.key.startsWith("see-all:") && "search-palette__item--see-all",
                    )}
                    onMouseDown={row ? (event) => event.preventDefault() : undefined}
                    onClick={row ? () => activateRow(row) : undefined}
                  >
                    <span className="search-palette__item-title">{item.title}</span>
                    {item.subtitle ? (
                      <span className="search-palette__item-subtitle">{item.subtitle}</span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          );
        })}

        {typing && !recordsEnabled && shown.length === 0 && !nothingFound ? (
          <p className="search-palette__empty">{t("globalSearch.minLengthHint")}</p>
        ) : null}
        {recordsLoading ? (
          <p role="status" className="search-palette__empty">
            {t("globalSearch.loading")}
          </p>
        ) : null}
        {typing && searchQuery.isError ? (
          <p role="alert" className="search-palette__empty">
            {t("globalSearch.error")}
          </p>
        ) : null}
      </div>
    </div>
  );
}
