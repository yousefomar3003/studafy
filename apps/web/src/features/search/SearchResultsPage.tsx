import { Button, Input } from "@studafy/ui";
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { usePermissions } from "../../lib/auth";
import { useTranslation } from "../../lib/i18n";

import {
  GLOBAL_SEARCH_MIN_QUERY_LENGTH,
  SEARCH_TYPES,
  isSearchType,
  useGlobalSearchQuery,
} from "./queries";
import { buildResultGroups, isNavigable } from "./result-groups";
import { searchResultsHref } from "./scoped-query";

import "./search-palette.css";

import type { SearchResultGroup } from "./result-groups";
import type { FormEvent } from "react";

/** Rows per page when one type is selected; the API's own maximum. */
export const SEARCH_RESULTS_PAGE_SIZE = 20;
/** The API refuses an offset past 1,000 (`SearchQuery.offset`), so paging stops there. */
const MAX_OFFSET = 1000;
const MAX_PAGES = Math.floor(MAX_OFFSET / SEARCH_RESULTS_PAGE_SIZE) + 1;

/**
 * The full record results behind the palette's "See all N" (`/portal/search?q=&type=&page=`): one
 * query, type filter chips with their counts, and paging through one type. Everything is in the
 * URL, so a results page is shareable and Back works. Rows link the same role-aware way as in the
 * palette (`recordHref`); the API scopes which records come back.
 */
export default function SearchResultsPage() {
  const [params] = useSearchParams();
  // Remount on a new query so the search box starts from it (Back, or a link from the palette).
  return <SearchResults key={params.get("q") ?? ""} />;
}

function SearchResults() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const permissions = usePermissions();
  const [params] = useSearchParams();

  const query = (params.get("q") ?? "").trim();
  const rawType = params.get("type") ?? "";
  const type = isSearchType(rawType) ? rawType : undefined;
  const page = Math.min(
    MAX_PAGES,
    Math.max(1, Number.parseInt(params.get("page") ?? "1", 10) || 1),
  );
  const searchable = query.length >= GLOBAL_SEARCH_MIN_QUERY_LENGTH;

  const [draft, setDraft] = useState(query);

  // All types (for the chips and their counts), and the selected type's page when one is chosen.
  const overview = useGlobalSearchQuery(searchable ? query : "");
  const filtered = useGlobalSearchQuery(searchable && type ? query : "", {
    type,
    limit: SEARCH_RESULTS_PAGE_SIZE,
    offset: (page - 1) * SEARCH_RESULTS_PAGE_SIZE,
  });

  const totals = overview.data?.totals;
  const chipTypes = SEARCH_TYPES.filter((candidate) => (totals?.[candidate] ?? 0) > 0);
  const active = type ? filtered : overview;
  const groups: SearchResultGroup[] = active.data
    ? buildResultGroups(active.data, permissions, t)
    : [];
  const typeTotal = type ? (filtered.data?.totals?.[type] ?? 0) : 0;
  const pages = Math.min(MAX_PAGES, Math.max(1, Math.ceil(typeTotal / SEARCH_RESULTS_PAGE_SIZE)));

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    navigate(searchResultsHref(draft.trim(), type));
  }

  return (
    <div className="search-results">
      <h1>{t("globalSearch.results.title")}</h1>

      <form className="search-results__form" role="search" onSubmit={onSubmit}>
        <Input
          label={t("globalSearch.results.queryLabel")}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button type="submit">{t("globalSearch.results.submit")}</Button>
      </form>

      {!searchable ? (
        <p className="search-results__empty">{t("globalSearch.results.minLength")}</p>
      ) : (
        <>
          {chipTypes.length > 0 ? (
            <nav
              className="search-results__filters"
              aria-label={t("globalSearch.results.filtersLabel")}
            >
              <Link
                className="search-results__filter"
                aria-current={type === undefined ? "page" : undefined}
                to={searchResultsHref(query)}
              >
                {t("globalSearch.results.allTypes")}
              </Link>
              {chipTypes.map((candidate) => (
                <Link
                  key={candidate}
                  className="search-results__filter"
                  aria-current={type === candidate ? "page" : undefined}
                  to={searchResultsHref(query, candidate)}
                >
                  {t(`globalSearch.groups.${candidate}`)}{" "}
                  <span className="search-results__filter-count">{totals?.[candidate]}</span>
                </Link>
              ))}
            </nav>
          ) : null}

          {active.isPending ? (
            <p role="status" className="search-results__empty">
              {t("globalSearch.loading")}
            </p>
          ) : active.isError ? (
            <p role="alert" className="search-results__empty">
              {t("globalSearch.error")}
            </p>
          ) : groups.length === 0 ? (
            <div className="search-results__empty">
              <p>{t("globalSearch.results.empty", { query })}</p>
              <p>{t("globalSearch.results.emptyHint")}</p>
            </div>
          ) : (
            groups.map((group) => (
              <section
                key={group.type}
                className="search-results__group"
                aria-labelledby={`search-results-${group.type}`}
              >
                <h2 id={`search-results-${group.type}`}>
                  {t(`globalSearch.groups.${group.type}`)}{" "}
                  <span className="search-results__group-count">
                    {t("globalSearch.results.count", { count: group.total })}
                  </span>
                </h2>
                <ul className="search-results__list">
                  {group.items.map((item) => (
                    <li key={item.key} className="search-results__item">
                      {isNavigable(item) ? (
                        <Link className="search-results__item-title" to={item.href}>
                          {item.title}
                        </Link>
                      ) : (
                        <span
                          className="search-results__item-title"
                          title={t("globalSearch.noDetailPage")}
                        >
                          {item.title}
                        </span>
                      )}
                      {item.subtitle ? (
                        <span className="search-results__item-subtitle">{item.subtitle}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
                {!type && group.total > group.items.length ? (
                  <Link
                    className="search-results__see-all"
                    to={searchResultsHref(query, group.type)}
                  >
                    {t("globalSearch.seeAll", { count: group.total })}
                  </Link>
                ) : null}
              </section>
            ))
          )}

          {type && pages > 1 ? (
            <nav
              className="search-results__pager"
              aria-label={t("globalSearch.results.pagination")}
            >
              {page > 1 ? (
                <Link to={searchResultsHref(query, type, page - 1)}>
                  {t("globalSearch.results.previous")}
                </Link>
              ) : null}
              <span>{t("globalSearch.results.pageOf", { page, pages })}</span>
              {page < pages ? (
                <Link to={searchResultsHref(query, type, page + 1)}>
                  {t("globalSearch.results.next")}
                </Link>
              ) : null}
            </nav>
          ) : null}
        </>
      )}
    </div>
  );
}
