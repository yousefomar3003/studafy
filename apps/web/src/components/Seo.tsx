import { useEffect } from "react";

export interface SeoProps {
  /** Page title. Rendered as "{title} | Studafy" — see SITE_NAME below. */
  title: string;
  /** One or two sentences. Used for the meta description and the OpenGraph/Twitter description. */
  description: string;
  /** Absolute path (e.g. "/pricing") this page canonicalizes to. Defaults to the current path. */
  path?: string;
}

const SITE_NAME = "Studafy";

function upsertMeta(attr: "name" | "property", key: string, content: string): void {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

function upsertCanonical(href: string): void {
  let el = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!el) {
    el = document.createElement("link");
    el.setAttribute("rel", "canonical");
    document.head.appendChild(el);
  }
  el.setAttribute("href", href);
}

/**
 * Sets the document title and meta description/canonical/OpenGraph tags for the current route.
 *
 * This is a Vite SPA with no server-side rendering, so there is no `<Head>` component to lean on —
 * a dependency like react-helmet would buy nothing over directly writing the three tags a crawler
 * actually reads. Lighthouse and search crawlers execute JS before scoring/indexing, so tags applied
 * on mount are present by the time either one looks. Runs on every render so a client-side
 * navigation between marketing pages (no full page load) still updates the tags.
 */
export function useSeo({ title, description, path }: SeoProps): void {
  useEffect(() => {
    const fullTitle = `${title} | ${SITE_NAME}`;
    document.title = fullTitle;

    upsertMeta("name", "description", description);
    upsertMeta("property", "og:title", fullTitle);
    upsertMeta("property", "og:description", description);
    upsertMeta("property", "og:type", "website");
    upsertMeta("name", "twitter:card", "summary");
    upsertMeta("name", "twitter:title", fullTitle);
    upsertMeta("name", "twitter:description", description);

    const canonicalPath = path ?? window.location.pathname;
    upsertCanonical(`${window.location.origin}${canonicalPath}`);
  }, [title, description, path]);
}
