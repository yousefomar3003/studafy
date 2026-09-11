import { useEffect } from "react";
import { Link, useLocation, useParams } from "react-router-dom";

import { useTranslation } from "../../lib/i18n";

import { articleBySlug, categoryLabel } from "./articles";
import { MarkdownContent } from "./markdown";

import "./help.css";

/** A single rendered help article. Deep-links like `/help/onboarding-guide#step-1-school-profile`
 * scroll to the target heading once the article mounts. */
export default function HelpArticlePage() {
  const { t } = useTranslation();
  const { slug } = useParams<{ slug: string }>();
  const { hash } = useLocation();
  const article = slug ? articleBySlug(slug) : undefined;

  useEffect(() => {
    if (!hash) return;
    document.getElementById(hash.slice(1))?.scrollIntoView({ block: "start" });
  }, [hash, article?.slug]);

  if (!article) {
    return (
      <div className="help-page">
        <p>
          <Link className="help-content__link" to="/help">
            ← {t("help.backHome")}
          </Link>
        </p>
        <h1>{t("help.articleNotFoundTitle")}</h1>
        <p>{t("help.articleNotFoundBody")}</p>
      </div>
    );
  }

  return (
    <article className="help-page" aria-labelledby="help-article-title">
      <nav className="help-breadcrumbs" aria-label="Breadcrumb">
        <Link className="help-content__link" to="/help">
          {t("help.title")}
        </Link>
        <span className="help-breadcrumbs__separator" aria-hidden="true">
          ›
        </span>
        <span className="help-breadcrumbs__current">{categoryLabel(article.category)}</span>
      </nav>

      <h1 id="help-article-title" className="help-article__title">
        {article.title}
      </h1>
      <p className="help-article__description">{article.description}</p>

      <MarkdownContent source={article.body} />
    </article>
  );
}
