import { createElement } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

import { slugify } from "./content";

import type { ReactNode } from "react";

/**
 * Markdown renderer for help articles. Heading ids are derived from the heading text via
 * `slugify` so other parts of the app (for example the onboarding wizard's step links) can deep-link
 * into an article from its canonical anchor. URLs are sanitized with react-markdown's default
 * transform; the articles are trusted first-party content, but the default costs nothing.
 */
export function MarkdownContent({ source }: { source: string }) {
  return (
    <div className="help-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          h2: heading(2),
          h3: heading(3),
          h4: heading(4),
          a: Anchor,
          img: Image,
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}

function heading(level: 2 | 3 | 4) {
  function Heading({ children }: { children?: ReactNode }) {
    const id = slugify(children?.toString() ?? "");
    return createElement(`h${level}`, { id }, children);
  }
  return Heading;
}

function Anchor({ href, children }: { href?: string; children?: ReactNode }) {
  return (
    <a href={href} className="help-content__link">
      {children}
    </a>
  );
}

function Image({ src, alt }: { src?: string; alt?: string }) {
  if (!src) return null;
  return (
    <img
      src={defaultUrlTransform(src)}
      alt={alt ?? ""}
      loading="lazy"
      className="help-content__img"
    />
  );
}
