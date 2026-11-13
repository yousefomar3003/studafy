import { useEffect } from "react";
import { Link, useLocation, useParams } from "react-router-dom";

import { LinkButton } from "../../components/LinkButton";
import { usePermissions, usePublicAuthStatus } from "../../lib/auth";
import { useTranslation } from "../../lib/i18n";
import { resolveDestination } from "../search/destinations";

import { articleBodyForPage, articleBySlug } from "./articles";
import { MarkdownContent } from "./markdown";

import "./help.css";

/** A single rendered help article. Deep-links like `/help/onboarding-guide#step-1-school-profile`
 * scroll to the target heading once the article mounts. */
export default function HelpArticlePage() {
  const { t } = useTranslation();
  const { slug } = useParams<{ slug: string }>();
  const { hash } = useLocation();
  // /help is public: restore the session for a browser that was signed in (as the marketing
  // header does), so "Do it now" also shows after a reload or a link opened in a new tab.
  usePublicAuthStatus();
  const permissions = usePermissions();
  const article = slug ? articleBySlug(slug) : undefined;
  // "Do it now" sends a signed-in reader to the task's page in the portal they can open; a reader
  // who cannot open it (or is signed out) gets the article alone. The route stays the real gate.
  const action = article?.action ? resolveDestination(article.action, permissions) : undefined;

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
      <nav className="help-breadcrumbs" aria-label={t("site.help.breadcrumb")}>
        <Link className="help-content__link" to="/help">
          {t("help.title")}
        </Link>
        <span className="help-breadcrumbs__separator" aria-hidden="true">
          ›
        </span>
        <span className="help-breadcrumbs__current">
          {t(`site.help.categories.${article.category}`)}
        </span>
      </nav>

      <h1 id="help-article-title" className="help-article__title">
        {article.title}
      </h1>
      <p className="help-article__description">{article.description}</p>
      {action ? (
        <p className="help-article__action">
          <LinkButton href={action.to}>{t("help.doItNow")}</LinkButton>
        </p>
      ) : null}

      <MarkdownContent source={articleBodyForPage(article.body)} />
    </article>
  );
}
