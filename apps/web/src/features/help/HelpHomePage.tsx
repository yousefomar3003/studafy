import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { useTranslation } from "../../lib/i18n";

import { articles, CATEGORY_ORDER, categoryLabel, helpPath, searchHelp } from "./articles";

import type { CategorySlug, HelpArticle } from "./content.types";

import "./help.css";

/** Catalog of every published help article, grouped by category, with a client-side search. */
export default function HelpHomePage() {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");

  const results = useMemo(() => (query.trim() ? searchHelp(query) : [...articles]), [query]);

  const byCategory = useMemo(
    () =>
      new Map<CategorySlug, HelpArticle[]>(
        CATEGORY_ORDER.map((category) => [
          category,
          results.filter((article) => article.category === category),
        ]),
      ),
    [results],
  );

  const anyResults = results.length > 0;

  return (
    <div className="help-home">
      <h1>{t("help.title")}</h1>
      <p className="help-home__tagline">{t("help.tagline")}</p>

      <section className="help-search" aria-label={t("help.searchLabel")}>
        <label className="help-search__label" htmlFor="help-search-input">
          {t("help.searchLabel")}
        </label>
        <input
          id="help-search-input"
          className="help-search__input"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("help.searchPlaceholder")}
          autoComplete="off"
        />
      </section>

      {!anyResults ? (
        <p className="help-home__empty">{t("help.noResults")}</p>
      ) : (
        CATEGORY_ORDER.filter((category) => byCategory.get(category)!.length > 0).map(
          (category) => (
            <section key={category} className="help-category" aria-label={categoryLabel(category)}>
              <h2 className="help-category__title">{categoryLabel(category)}</h2>
              <ul className="help-category__list">
                {byCategory.get(category)!.map((article) => (
                  <li key={article.slug}>
                    <Link to={helpPath(article.slug)} className="help-card">
                      <span className="help-card__title">{article.title}</span>
                      <span className="help-card__description">{article.description}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ),
        )
      )}
    </div>
  );
}
