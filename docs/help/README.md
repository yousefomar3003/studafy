---
title: "Help center authoring guide"
description: "Conventions for writing and maintaining admin help content in this directory."
keywords: ["authoring", "conventions", "frontmatter", "screenshots"]
order: 0
publish: false
---

# Help center authoring guide

This directory is the source of truth for the admin help center. The web app
bundles these files at build time and renders them under `/help`. This file
documents the rules. It is not published to the site (`publish: false`).

## Layout and naming

- One markdown file per article. The file name is the canonical slug and the
  URL path: `getting-started/onboarding-guide.md` renders at
  `/help/onboarding-guide`.
- Register each new file in
  `apps/web/src/features/help/articles.ts` — one import line pulls its raw
  markdown through the `@docs` Vite alias (`vite.config.ts` maps `@docs` to
  this repo-root `docs/` directory), plus one entry in `ARTICLE_SOURCES`.
- The parent directory is the canonical category slug:
  `getting-started`, `academics`, `finance`, `billing`. Category display
  labels live in `apps/web/src/features/help/content.ts` — do not duplicate
  them in frontmatter.
- Slugs are `kebab-case`, lowercase ASCII, one noun phrase, no numbers unless
  they are part of the name (`onboarding-guide`, not `guide-v2`).

## Frontmatter

Every published file starts with a `---` block. Supported keys:

| Key           | Required | Rules                                                                         |
| ------------- | -------- | ----------------------------------------------------------------------------- |
| `title`       | yes      | Human-readable, sentence case. Used for the page heading and search.          |
| `description` | yes      | One sentence. Used for listing cards and search.                              |
| `keywords`    | no       | Comma-agnostic YAML list of search terms, e.g. `["setup", "wizard", "skip"]`. |
| `order`       | yes      | Integer. Sort order within the category, ascending.                           |
| `publish`     | no       | `true` by default. Set `false` for drafts.                                    |

The parser is deliberately small (regex-based). Use the exact `key: value`
form above. Do not use colons inside values.

## Markdown subset

The renderer supports: ATX headings (`#`…`#####`), paragraphs, bullet and
ordered lists, bold, italic, inline code, fenced code blocks, blockquotes,
links, images, and GFM tables. Write plain prose — no HTML, no footnotes, no
emoji.

Heading slugs are derived deterministically from heading text: lowercase,
spaces and punctuation to hyphens, collapse repeats. Keep headings short and
stable — they are link targets (for example the onboarding wizard links to
`/help/onboarding-guide#step-1-school-profile`).

## Writing rules

- Say what the screen does, what each field does, and what happens when you
  save. Show exact button labels in backticks: "Click `Save and continue`".
- Give defaults explicitly ("defaults to 7"). Copy state changes that matter
  ("pending confirmation from a different user").
- Do not promise behavior the code does not guarantee. When a value is
  validated or rejected server-side, say so.
- Keep an article to a single task. Five short articles beat one long one.
- One idea per heading level. Do not nest headings deeper than `###`.

## Screenshots

Images are generated, not hand-staged, so they stay current:

- `apps/web/e2e/help-screenshots.spec.ts` (Playwright) drives the app's own
  dev server with stubbed backends and seeds the wizard's progress, then
  captures each documented step into
  `apps/web/public/help-media/screenshots/`. No Postgres or `apps/api`
  needed — run it with `bun run e2e:help-screenshots` from `apps/web`.
- Articles reference them at the web path
  `/help-media/screenshots/<name>.png` with descriptive alt text.
- Re-run the spec when a screen changes and commit the new PNGs. Do not paste
  hand-taken crops. `apps/web/e2e/help-center.spec.ts` fails if a documented
  screenshot is missing or won't load, so a regenerating-but-committing change
  cannot silently drift.

The PNGs are checked in, so articles render fully from a fresh checkout. The
text is still the source of truth — a screenshot that no longer matches the
copy it sits under is a sign to re-capture, and the spec above is how.
