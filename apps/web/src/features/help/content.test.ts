import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import {
  articleBodyForPage,
  buildArticles,
  searchArticles,
  searchHelpArticles,
  slugify,
} from "./content";
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
    'title: "Timetables"\ndescription: "Build a working timetable."\nkeywords: [timetable, periods]\ntitle_ar: "الجدول الدراسي"\ndescription_ar: "أنشئ جدولًا دراسيًا يعمل."\nkeywords_ar: [جدول, حصص]\norder: 1',
});
const INVITATIONS = rawArticle({
  path: "docs/help/getting-started/invitations.md",
  frontmatter:
    'title: "Invitations"\ndescription: "Invite staff, students and parents."\nkeywords: [invitation, link, email]\ntitle_ar: "الدعوات"\ndescription_ar: "ادعُ الموظفين والطلاب وأولياء الأمور."\nkeywords_ar: [دعوة, رابط]\norder: 2',
});
const WORKFLOWS = rawArticle({
  path: "docs/help/finance/workflows.md",
  frontmatter:
    'title: "Finance workflows"\ndescription: "Set up and run subscription workflows, including refunds."\nkeywords: [refund, invoice]\ntitle_ar: "سير العمل المالي"\ndescription_ar: "إعداد الفواتير والمدفوعات والاسترداد."\nkeywords_ar: [استرداد, فاتورة]\nroles: [FINANCE]\norder: 1',
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
      titleAr: "الجدول الدراسي",
      descriptionAr: "أنشئ جدولًا دراسيًا يعمل.",
      keywordsAr: ["جدول", "حصص"],
      roles: [],
      action: null,
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
        'title: "Subscriptions"\ndescription: "Plans and pricing."\nkeywords: [plan]\ntitle_ar: "الاشتراكات"\ndescription_ar: "الخطط والأسعار."\nkeywords_ar: [خطة]\norder: 1',
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

/** Minimal published frontmatter, Arabic keys included; `extra` lines are appended. */
function published(slug: string, category: string, extra = "", body = "Body"): RawArticleLike {
  return rawArticle({
    path: `docs/help/${category}/${slug}.md`,
    frontmatter: `title: "${slug}"\ndescription: "About ${slug}."\ntitle_ar: "عنوان"\ndescription_ar: "وصف"\nkeywords_ar: [كلمة]\norder: 1${extra ? `\n${extra}` : ""}`,
    body,
  });
}

describe("buildArticles — Arabic, roles and action frontmatter", () => {
  test("parses title_ar, description_ar, keywords_ar, roles and action", () => {
    const article = articleFrom(
      rawArticle({
        path: "docs/help/finance/issue-refund.md",
        frontmatter: [
          'title: "Issue a refund"',
          'description: "Request and approve a refund."',
          'keywords: ["refund", "credit note"]',
          'title_ar: "إصدار استرداد"',
          'description_ar: "اطلب استردادًا ثم اعتمده."',
          'keywords_ar: ["استرداد", "إشعار دائن"]',
          "roles: [FINANCE, ORG_ADMIN]",
          "action: issue-refund",
          "order: 4",
        ].join("\n"),
      }),
    );

    expect(article.titleAr).toBe("إصدار استرداد");
    expect(article.descriptionAr).toBe("اطلب استردادًا ثم اعتمده.");
    expect(article.keywords).toEqual(["refund", "credit note"]);
    expect(article.keywordsAr).toEqual(["استرداد", "إشعار دائن"]);
    expect(article.roles).toEqual(["FINANCE", "ORG_ADMIN"]);
    expect(article.action).toBe("issue-refund");
  });

  test("accepts Prettier's multi-line list form for keywords_ar and roles", () => {
    const article = articleFrom(
      rawArticle({
        path: "docs/help/finance/x.md",
        frontmatter:
          'title: "X"\ndescription: "X."\nkeywords:\n  [\n    "a",\n    "b",\n  ]\ntitle_ar: "س"\ndescription_ar: "س."\nkeywords_ar:\n  [\n    "فاتورة",\n    "دفعة",\n  ]\nroles:\n  [\n    FINANCE,\n  ]\norder: 1',
      }),
    );

    expect(article.keywords).toEqual(["a", "b"]);
    expect(article.keywordsAr).toEqual(["فاتورة", "دفعة"]);
    expect(article.roles).toEqual(["FINANCE"]);
  });

  test("defaults roles to [] and action to null", () => {
    const article = articleFrom(published("plain", "academics"));
    expect(article.roles).toEqual([]);
    expect(article.action).toBeNull();
  });

  test("throws on a role that is not in ROLES", () => {
    expect(() =>
      buildArticles([published("x", "finance", "roles: [FINANCE, ACCOUNTANT]")]),
    ).toThrow(/unknown roles: ACCOUNTANT/);
  });

  test("throws on an action id that is not kebab-case", () => {
    expect(() => buildArticles([published("x", "finance", "action: Issue_Refund")])).toThrow(
      /invalid action id/,
    );
  });

  test("throws for a published article missing its Arabic frontmatter", () => {
    expect(() =>
      buildArticles([
        rawArticle({
          path: "docs/help/academics/english-only.md",
          frontmatter: 'title: "English only"\ndescription: "No Arabic."\norder: 1',
        }),
      ]),
    ).toThrow(/missing Arabic frontmatter: title_ar, description_ar, keywords_ar/);
    expect(() =>
      buildArticles([
        rawArticle({
          path: "docs/help/academics/no-keywords.md",
          frontmatter:
            'title: "T"\ndescription: "D."\ntitle_ar: "ع"\ndescription_ar: "و"\norder: 1',
        }),
      ]),
    ).toThrow(/missing Arabic frontmatter: keywords_ar$/);
  });

  test("does not require Arabic frontmatter on unpublished files", () => {
    const draft = rawArticle({
      path: "docs/help/academics/draft.md",
      frontmatter: 'title: "Draft"\ndescription: "Not ready."\norder: 1\npublish: false',
    });
    expect(buildArticles([draft])).toEqual([]);
  });
});

describe("searchHelpArticles", () => {
  const STUDENTS = published(
    "add-student",
    "getting-started",
    'keywords: [student, enrol]\ntitle_ar: "إضافة طالب"\ndescription_ar: "أنشئ ملف طالب جديد."\nkeywords_ar: [طالب, أحمد, تسجيل]\nroles: [ORG_ADMIN]',
    "Intro text.\n\n## Open the Students list\n\nGo to the list.\n\n### Fill in the form\n\nEnter the admission number and save.\n",
  );
  const REFUND = published(
    "issue-refund",
    "finance",
    "keywords: [refund]\nroles: [FINANCE]\nkeywords_ar: [استرداد]",
    "## Request a refund\n\nPick the invoice.",
  );
  const PAYMENTS = published(
    "record-payment",
    "finance",
    "keywords: [payment, refund]",
    "## Record it\n\nA refund is separate.",
  );

  // `published()` puts a default title_ar/keywords_ar line first; the later line wins.
  const corpus = [STUDENTS, REFUND, PAYMENTS].map(articleFrom);

  test("returns no hits for an empty query", () => {
    expect(searchHelpArticles("   ", corpus)).toEqual([]);
  });

  test("finds an article from its Arabic title, with or without hamza", () => {
    expect(searchHelpArticles("إضافة طالب", corpus)[0]?.article.slug).toBe("add-student");
    expect(searchHelpArticles("اضافة طالب", corpus)[0]?.article.slug).toBe("add-student");
    expect(searchHelpArticles("احمد", corpus).map((hit) => hit.article.slug)).toEqual([
      "add-student",
    ]);
  });

  test("ignores the Arabic definite article on either side", () => {
    expect(searchHelpArticles("الطالب", corpus)[0]?.article.slug).toBe("add-student");
  });

  test("matches the last token as a prefix while the user is typing", () => {
    expect(searchHelpArticles("stud", corpus)[0]?.article.slug).toBe("add-student");
    expect(searchHelpArticles("طال", corpus)[0]?.article.slug).toBe("add-student");
    // Earlier tokens must be whole words.
    expect(searchHelpArticles("stud form", corpus)).toEqual([]);
  });

  test("requires every token to match", () => {
    expect(searchHelpArticles("admission refund", corpus)).toEqual([]);
  });

  test("returns the heading the best body match sits under, with its anchor slug", () => {
    const [hit] = searchHelpArticles("admission number", corpus);
    expect(hit.article.slug).toBe("add-student");
    expect(hit.heading).toEqual({ text: "Fill in the form", slug: "fill-in-the-form" });

    const [headingHit] = searchHelpArticles("students list", corpus);
    expect(headingHit.heading).toEqual({
      text: "Open the Students list",
      slug: "open-the-students-list",
    });
  });

  test("returns no heading when the body did not match", () => {
    const [hit] = searchHelpArticles("enrol", corpus);
    expect(hit.heading).toBeNull();
  });

  test("boosts articles written for the caller's roles", () => {
    // Same text, different audiences: catalogue order breaks the tie until a role boosts one.
    const general = published("fees-general", "finance", "keywords: [fees]");
    const forFinance = published("fees-finance", "finance", "keywords: [fees]\nroles: [FINANCE]");
    const sameText = [general, forFinance].map(articleFrom);
    const slugs = (roles?: string[]) =>
      searchHelpArticles("fees", sameText, { roles }).map((hit) => hit.article.slug);

    expect(slugs()).toEqual(["fees-general", "fees-finance"]);
    expect(slugs(["PRINCIPAL"])).toEqual(["fees-general", "fees-finance"]);
    expect(slugs(["FINANCE"])).toEqual(["fees-finance", "fees-general"]);
    expect(slugs(["PARENT", "FINANCE"])).toEqual(["fees-finance", "fees-general"]);
  });

  test("never hides an article: a role filter only reorders", () => {
    const admin = searchHelpArticles("refund", corpus, { roles: ["ORG_ADMIN"] });
    const parent = searchHelpArticles("refund", corpus, { roles: ["PARENT"] });
    expect(admin.map((hit) => hit.article.slug).sort()).toEqual(["issue-refund", "record-payment"]);
    expect(parent.map((hit) => hit.article.slug).sort()).toEqual([
      "issue-refund",
      "record-payment",
    ]);
    expect(searchHelpArticles("admission", corpus, { roles: ["FINANCE"] })[0]?.article.slug).toBe(
      "add-student",
    );
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
      "student-and-parent-records",
      "invite-staff",
      "add-student",
      "import-students",
      "link-parent",
      "timetable",
      "academic-setup",
      "build-timetable",
      "take-attendance",
      "workflows",
      "create-invoice-batch",
      "record-payment",
      "issue-refund",
      "subscriptions",
    ]);
    for (const article of articles) {
      expect(article.keywordsAr.length).toBeGreaterThanOrEqual(5);
      expect(article.keywordsAr.length).toBeLessThanOrEqual(15);
    }
    expect(
      Object.fromEntries(
        articles
          .filter((article) => article.action)
          .map((article) => [article.slug, article.action]),
      ),
    ).toEqual({
      "add-student": "add-student",
      "import-students": "import-students",
      "link-parent": "link-parent",
      "invite-staff": "invite-staff",
      "academic-setup": "set-up-academics",
      "build-timetable": "build-timetable",
      "take-attendance": "take-attendance",
      "create-invoice-batch": "create-invoice-batch",
      "record-payment": "record-payment",
      "issue-refund": "issue-refund",
    });
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

describe("articleBodyForPage", () => {
  test("drops the leading # title the page already shows", () => {
    expect(articleBodyForPage("# Add a student\n\n## Open the list\n\nText.")).toBe(
      "\n## Open the list\n\nText.",
    );
  });

  test("keeps a body that starts with anything else, and later H1s", () => {
    expect(articleBodyForPage("## Step 1\n\n# Not a title")).toBe("## Step 1\n\n# Not a title");
    expect(articleBodyForPage("Intro\n\n# Later")).toBe("Intro\n\n# Later");
  });
});
