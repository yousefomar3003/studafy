import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { buildArticles, searchArticles, slugify } from "./content";
import { ONBOARDING_STEP_ANCHORS } from "./onboarding-guide-links";

import type { HelpArticle } from "./content.types";

interface RawArticleLike {
  path: string;
  raw: string;
}

function rawArticle(options: { path: string; frontmatter: string; body?: string }): RawArticleLike {
  return { path: options.path, raw: `---\n${options.frontmatter}\n---\n${options.body ?? "Body"}` };
}

/** Builds a single published article from one fixture. */
function articleFrom(raw: RawArticleLike): HelpArticle {
  return buildArticles([raw])[0];
}

const TIMETABLE = rawArticle({
  path: "docs/help/academics/timetable.md",
  frontmatter:
    'title: "Timetables"\ndescription: "Build a working timetable."\nkeywords: [timetable, periods]\norder: 1',
});
const INVITATIONS = rawArticle({
  path: "docs/help/getting-started/invitations.md",
  frontmatter:
    'title: "Invitations"\ndescription: "Invite staff, students and parents."\nkeywords: [invitation, link, email]\norder: 2',
});
const WORKFLOWS = rawArticle({
  path: "docs/help/finance/workflows.md",
  frontmatter:
    'title: "Finance workflows"\ndescription: "Set up and run subscription workflows, including refunds."\nkeywords: [refund, invoice]\norder: 1',
});

describe("buildArticles", () => {
  test("parses frontmatter, strips the frontmatter block, and derives slug and category", () => {
    const [article] = buildArticles([TIMETABLE]);

    expect(article).toEqual({
      slug: "timetable",
      category: "academics",
      title: "Timetables",
      description: "Build a working timetable.",
      keywords: ["timetable", "periods"],
      order: 1,
      body: "Body",
    });
  });

  test("groups by category order, then by order, then by slug", () => {
    const articles = buildArticles([TIMETABLE, INVITATIONS, WORKFLOWS]);

    expect(articles.map((article) => article.slug)).toEqual([
      "invitations", // getting-started first
      "timetable", // academics
      "workflows", // finance
    ]);
  });

  test("skips files outside a known category, like docs/help/README.md", () => {
    const readme = rawArticle({
      path: "docs/help/README.md",
      frontmatter:
        'publish: false\ntitle: "Authoring guide"\ndescription: "How help content is authored."',
    });

    expect(buildArticles([readme, TIMETABLE]).map((article) => article.slug)).toEqual([
      "timetable",
    ]);
  });

  test("excludes articles published with publish: 0", () => {
    const draft = rawArticle({
      path: "docs/help/academics/draft.md",
      frontmatter: 'title: "Draft"\ndescription: "Not ready."\nkeywords: []\norder: 1\npublish: 0',
    });

    expect(buildArticles([draft, TIMETABLE]).map((article) => article.slug)).toEqual(["timetable"]);
  });

  test("throws on an unsupported frontmatter line instead of silently dropping content", () => {
    const broken = rawArticle({
      path: "docs/help/academics/broken.md",
      frontmatter: 'title: "Broken"\nwat: true',
    });

    expect(() => buildArticles([broken])).toThrow(/unsupported frontmatter line/);
  });

  test("throws when the frontmatter block is missing", () => {
    expect(() =>
      buildArticles([{ path: "docs/help/academics/x.md", raw: "no frontmatter" }]),
    ).toThrow(/missing its frontmatter/);
  });
});

describe("slugify", () => {
  test("produces the canonical heading anchors the onboarding wizard deep-links to", () => {
    expect(slugify("Step 5: Staff invitations")).toBe("step-5-staff-invitations");
  });
});

describe("searchArticles", () => {
  test("returns every article for an empty query", () => {
    const corpus = [TIMETABLE, INVITATIONS, WORKFLOWS].map(articleFrom);
    expect(
      searchArticles("", corpus)
        .map((article) => article.slug)
        .sort(),
    ).toEqual(["invitations", "timetable", "workflows"]);
  });

  test("ranks an article that hits title, description and keywords above a body-only hit", () => {
    const bodyHit = rawArticle({
      path: "docs/help/billing/body-hit.md",
      frontmatter:
        'title: "Subscriptions"\ndescription: "Plans and pricing."\nkeywords: [plan]\norder: 1',
      body: "The refund process requires an approved workflow.",
    });
    const corpus = [articleFrom(bodyHit), articleFrom(WORKFLOWS)];

    expect(searchArticles("refund", corpus)[0].slug).toBe("workflows");
  });

  test("finds a keyword hit even when the term appears nowhere else", () => {
    const corpus = [INVITATIONS, TIMETABLE, WORKFLOWS].map(articleFrom);

    expect(searchArticles("invoice", corpus).map((article) => article.slug)).toEqual(["workflows"]);
  });

  test("is case-insensitive", () => {
    const corpus = [INVITATIONS].map(articleFrom);
    expect(searchArticles("INVITE", corpus).map((article) => article.slug)).toEqual([
      "invitations",
    ]);
  });

  test("returns nothing when no article matches", () => {
    const corpus = [INVITATIONS, TIMETABLE, WORKFLOWS].map(articleFrom);
    expect(searchArticles("unrelated", corpus)).toEqual([]);
  });
});

describe("published docs", () => {
  test("every real article in /docs/help parses into the advertised catalogue", async () => {
    const docsRoot = join(import.meta.dir, "..", "..", "..", "..", "..", "docs", "help");
    const files = await listMarkdown(docsRoot);
    const raw = await Promise.all(
      files.map(async (file) => ({
        path: file.replace(/\\/g, "/"),
        raw: await readFile(file, "utf8"),
      })),
    );

    const articles = buildArticles(raw);
    expect(articles.map((article) => article.slug)).toEqual([
      "onboarding-guide",
      "invitations",
      "timetable",
      "workflows",
      "subscriptions",
    ]);
  });

  test("onboarding guide headings stay in sync with the wizard's step anchors", async () => {
    const guidePath = join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "..",
      "..",
      "docs",
      "help",
      "getting-started",
      "onboarding-guide.md",
    );
    const headings = (await readFile(guidePath, "utf8"))
      .split(/\r?\n/)
      .filter((line) => /^#{2,3} Step \d+:/.test(line))
      .map((line) => slugify(line.replace(/^#+\s*/, "")));

    expect(headings).toEqual(Object.values(ONBOARDING_STEP_ANCHORS));
  });
});

async function listMarkdown(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) return listMarkdown(full);
        if (entry.name.endsWith(".md")) return [full];
        return [];
      }),
    )
  ).flat();
}
