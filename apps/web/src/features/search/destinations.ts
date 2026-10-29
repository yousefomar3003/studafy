import { PERMISSIONS } from "@studafy/constants";

import { loadCatalogAreasIn, SUPPORTED_LOCALES } from "../../lib/i18n";
import { i18next } from "../../lib/i18n/i18next";

import { normalizeSearchText, searchTokens } from "./normalize";

import type { Permission } from "@studafy/constants";

/**
 * The global search's "Go to" (kind `page`) and "Do" (kind `action`) results: every page a signed-in
 * staff member can open from the web portal, plus the tasks they come to do, each with the words
 * staff actually type for it. This is the single source of truth — the palette, its empty state and
 * the help articles' "do it now" links all read it.
 *
 * Rules (pinned by `destinations.test.ts`, which walks the real route tree):
 *
 * - every authenticated page without a `:param` has an entry (a `:param` page is reached through a
 *   record result instead), or is listed in that test's EXEMPT list with a reason;
 * - `requiredPermission` is exactly the route's `RequirePermission` (none ↔ none), and
 *   `schoolScoped` means what it means in `layouts/portal/nav-items.ts`: hidden from platform
 *   operators;
 * - `alsoRequires` / `alsoRequiresAny` are checks the page itself makes before offering the thing
 *   (a tab it hides, a button it disables). They only ever narrow who sees an entry, never widen it;
 * - where one task lives in two portals (the admin's and the principal's), each gets its own entry,
 *   the second naming the first in `variantOf`. A session sees only the first of a group it can open,
 *   and {@link resolveDestination} maps either id to that one — so a help article can link to
 *   `build-timetable` and a principal still lands on their own timetable page.
 *
 * Titles, breadcrumbs and keywords live in the `search` catalog area
 * (`locales/{en,ar}/search.json`, under `search.destinations.<id>`), keywords as one
 * comma-separated string (`,` or `،`).
 */
export interface SearchDestination {
  readonly id: string;
  readonly kind: "page" | "action";
  /** i18n key of the result's title. */
  readonly titleKey: string;
  /** i18n key of the breadcrumb shown under it, e.g. "Principal › Academic setup › Subjects". */
  readonly whereKey?: string;
  /** Route, including any query string (`?create=1` opens the page's create modal). */
  readonly to: string;
  /** Identical to the route's `RequirePermission`; omitted for routes without one. */
  readonly requiredPermission?: Permission;
  /** Same meaning as `PortalNavItem.schoolScoped`: hidden from platform operators. */
  readonly schoolScoped?: true;
  /** i18n key of a comma-separated keyword string. */
  readonly keywordsKey: string;
  /** Every one of these is also needed — the page checks them before offering the task. */
  readonly alsoRequires?: readonly Permission[];
  /** At least one of these is also needed — the page shows the tab to any of them. */
  readonly alsoRequiresAny?: readonly Permission[];
  /** The canonical entry this one stands in for in another portal (see the module comment). */
  readonly variantOf?: string;
}

/** The catalog area holding every destination's strings. */
export const SEARCH_CATALOG_AREA = "search" as const;

type Options = Partial<
  Pick<
    SearchDestination,
    "requiredPermission" | "schoolScoped" | "alsoRequires" | "alsoRequiresAny" | "variantOf"
  >
>;

function entry(
  id: string,
  kind: SearchDestination["kind"],
  to: string,
  options: Options = {},
): SearchDestination {
  const base = `search.destinations.${id}`;
  return {
    id,
    kind,
    titleKey: `${base}.title`,
    whereKey: `${base}.where`,
    to,
    keywordsKey: `${base}.keywords`,
    ...options,
  };
}

const P = PERMISSIONS;
const SCHOOL = { schoolScoped: true } as const;
const PLATFORM = { requiredPermission: P.PLATFORM_READ } as const;
const ADMIN = { requiredPermission: P.ORGANIZATION_MANAGE_SETTINGS, ...SCHOOL } as const;
const PRINCIPAL = { requiredPermission: P.PRINCIPAL_DASHBOARD_VIEW, ...SCHOOL } as const;
const ACADEMIC = { requiredPermission: P.ACADEMIC_CONFIG_READ, ...SCHOOL } as const;
const ATTENDANCE = { requiredPermission: P.ATTENDANCE_DASHBOARD_VIEW, ...SCHOOL } as const;
const LICENSE = { requiredPermission: P.LICENSE_READ, ...SCHOOL } as const;
const FINANCE_REPORTS = { requiredPermission: P.REPORT_VIEW_FINANCIAL, ...SCHOOL } as const;
const BILLING_READ = { requiredPermission: P.BILLING_READ, ...SCHOOL } as const;
const BILLING_UPDATE = { requiredPermission: P.BILLING_UPDATE, ...SCHOOL } as const;

const SETUP = "/portal/principal/academic-setup";

/**
 * In preference order within each `variantOf` group: the admin's copy of a shared task comes before
 * the principal's, so an org admin (who can open both) is sent to their own console.
 */
export const SEARCH_DESTINATIONS: readonly SearchDestination[] = [
  // Every signed-in session.
  entry("home", "page", "/portal"),
  entry("notifications", "page", "/portal/notifications"),
  entry("notification-preferences", "page", "/portal/notifications/preferences"),
  entry("account", "page", "/account"),
  entry("account-sessions", "page", "/account/sessions"),
  entry("delete-account", "action", "/account/delete"),
  entry("help", "page", "/help"),

  // The Studafy platform console (SUPER_ADMIN).
  entry("platform-overview", "page", "/portal/platform", PLATFORM),
  entry("platform-schools", "page", "/portal/platform/schools", PLATFORM),
  entry("review-school-applications", "action", "/portal/platform/applications", PLATFORM),
  entry("platform-inquiries", "page", "/portal/platform/inquiries", PLATFORM),
  entry("review-platform-refunds", "action", "/portal/platform/refunds", PLATFORM),
  entry("platform-finance", "page", "/portal/platform/finance", PLATFORM),
  entry("platform-ai-usage", "page", "/portal/platform/ai", PLATFORM),
  entry("platform-plans", "page", "/portal/platform/plans", PLATFORM),
  entry("platform-settings", "page", "/portal/platform/settings", PLATFORM),
  entry("look-up-account", "action", "/portal/platform/users", PLATFORM),
  entry("platform-features", "page", "/portal/platform/features", PLATFORM),
  entry("platform-tiers", "page", "/portal/platform/tiers", PLATFORM),
  entry("platform-pricing", "page", "/portal/platform/pricing", PLATFORM),
  entry("build-license-quote", "action", "/portal/platform/quotes", PLATFORM),
  entry("platform-licenses", "page", "/portal/platform/licenses", PLATFORM),
  entry("platform-payments", "page", "/portal/platform/payments", PLATFORM),

  // The school admin's console.
  entry("run-setup-wizard", "action", "/onboarding/setup", ADMIN),
  entry("admin-dashboard", "page", "/portal/admin", ADMIN),
  entry("admin-users", "page", "/portal/admin/users", ADMIN),
  entry("add-parent", "action", "/portal/admin/users?create=PARENT", {
    ...ADMIN,
    alsoRequires: [P.USER_CREATE],
  }),
  entry("add-teacher", "action", "/portal/admin/users?create=INSTRUCTOR", {
    ...ADMIN,
    alsoRequires: [P.USER_CREATE],
  }),
  entry("staff-accounts", "page", "/portal/accounts", ADMIN),
  entry("invite-staff", "action", "/portal/accounts?invite=1", ADMIN),
  entry("school-members", "page", "/portal/members", ADMIN),
  entry("admin-students", "page", "/portal/admin/students", ADMIN),
  // The list only offers "New student" and "Import CSV" to these permissions.
  entry("add-student", "action", "/portal/admin/students?create=1", {
    ...ADMIN,
    alsoRequires: [P.STUDENT_CREATE],
  }),
  entry("import-students", "action", "/portal/admin/students/import", {
    ...ADMIN,
    alsoRequires: [P.STUDENT_IMPORT],
  }),
  entry("build-timetable", "action", "/portal/admin/timetable", ADMIN),
  entry("school-calendar", "page", "/portal/admin/calendar", {
    requiredPermission: P.CALENDAR_EVENT_READ,
    ...SCHOOL,
    alsoRequires: [P.ORGANIZATION_MANAGE_SETTINGS],
  }),
  entry("add-calendar-event", "action", "/portal/admin/calendar?create=1", {
    requiredPermission: P.CALENDAR_EVENT_READ,
    ...SCHOOL,
    alsoRequires: [P.ORGANIZATION_MANAGE_SETTINGS, P.CALENDAR_EVENT_MANAGE],
  }),
  entry("school-settings", "page", "/portal/admin/settings", ADMIN),
  entry("build-record-templates", "action", "/portal/admin/settings/records", {
    requiredPermission: P.RECORD_TEMPLATE_MANAGE,
    ...SCHOOL,
    alsoRequires: [P.ORGANIZATION_MANAGE_SETTINGS],
  }),
  entry("missing-information", "page", "/portal/admin/records/missing", {
    requiredPermission: P.STUDENT_RECORD_READ,
    ...SCHOOL,
    alsoRequires: [P.ORGANIZATION_MANAGE_SETTINGS],
  }),
  entry("create-announcement", "action", "/portal/admin/announcements", {
    requiredPermission: P.NOTIFICATION_MANAGE,
    ...SCHOOL,
  }),
  // Linking is the school admin's job: Unlinked only offers it with these three (see UnlinkedPage).
  entry("link-parent", "action", "/portal/finance/unlinked", {
    ...BILLING_READ,
    alsoRequires: [P.STUDENT_UPDATE, P.STUDENT_READ, P.ORGANIZATION_MANAGE_SETTINGS],
  }),

  // School leadership.
  entry("principal-dashboard", "page", "/portal/principal", PRINCIPAL),
  entry("discipline", "page", "/portal/principal/discipline", PRINCIPAL),
  entry("message-reports", "page", "/portal/principal/message-reports", {
    requiredPermission: P.MESSAGE_REPORT_REVIEW,
    ...SCHOOL,
  }),
  entry("principal-attendance", "page", "/portal/principal/attendance", PRINCIPAL),
  entry("evaluations", "page", "/portal/principal/evaluations", PRINCIPAL),
  entry("start-evaluation", "action", "/portal/principal/evaluations?create=1", {
    ...PRINCIPAL,
    alsoRequires: [P.EVALUATION_CREATE],
  }),
  entry("evaluation-templates", "page", "/portal/principal/evaluations/templates", PRINCIPAL),
  entry("principal-grades", "page", "/portal/principal/grades", PRINCIPAL),
  entry("school-calendar-principal", "page", "/portal/principal/calendar", {
    requiredPermission: P.CALENDAR_EVENT_READ,
    ...SCHOOL,
    variantOf: "school-calendar",
  }),
  entry("add-calendar-event-principal", "action", "/portal/principal/calendar?create=1", {
    requiredPermission: P.CALENDAR_EVENT_READ,
    ...SCHOOL,
    alsoRequires: [P.CALENDAR_EVENT_MANAGE],
    variantOf: "add-calendar-event",
  }),
  entry("build-timetable-principal", "action", "/portal/principal/timetable", {
    ...PRINCIPAL,
    alsoRequires: [P.TIMETABLE_MANAGE],
    variantOf: "build-timetable",
  }),
  entry("principal-classes", "page", "/portal/principal/classes", PRINCIPAL),
  entry("grades-sections", "page", "/portal/principal/sections", {
    requiredPermission: P.TIMETABLE_MANAGE,
    ...SCHOOL,
  }),
  // Academic setup and its screens (sub-routes inside AcademicSetupPage, one gate for all).
  entry("set-up-academics", "action", SETUP, ACADEMIC),
  entry("academic-subjects", "page", `${SETUP}/subjects`, ACADEMIC),
  entry("academic-sections", "page", `${SETUP}/sections`, ACADEMIC),
  entry("academic-scales", "page", `${SETUP}/scales`, ACADEMIC),
  entry("academic-approvals", "page", `${SETUP}/approvals`, {
    ...ACADEMIC,
    alsoRequires: [P.APPROVAL_REVIEW],
  }),
  entry("academic-results", "page", `${SETUP}/results`, {
    ...ACADEMIC,
    alsoRequiresAny: [P.RESULT_FINALIZE, P.ACADEMIC_CERTIFICATE_ISSUE],
  }),
  entry("build-record-templates-principal", "action", "/portal/principal/school/records", {
    requiredPermission: P.RECORD_TEMPLATE_MANAGE,
    ...SCHOOL,
    variantOf: "build-record-templates",
  }),
  entry("missing-information-principal", "page", "/portal/principal/records/missing", {
    requiredPermission: P.STUDENT_RECORD_READ,
    ...SCHOOL,
    alsoRequires: [P.PRINCIPAL_DASHBOARD_VIEW],
    variantOf: "missing-information",
  }),
  entry("principal-students", "page", "/portal/principal/students", {
    ...PRINCIPAL,
    variantOf: "admin-students",
  }),

  // The attendance office.
  entry("attendance-office", "page", "/portal/attendance", ATTENDANCE),
  entry("take-attendance", "action", "/portal/attendance", {
    ...ATTENDANCE,
    alsoRequires: [P.ATTENDANCE_RECORD_CREATE],
  }),
  entry("correct-attendance", "action", "/portal/attendance", {
    ...ATTENDANCE,
    alsoRequires: [P.ATTENDANCE_RECORD_CORRECT],
  }),
  entry("attendance-reports", "page", "/portal/attendance/reports", {
    requiredPermission: P.ATTENDANCE_REPORT_EXPORT,
    ...SCHOOL,
  }),

  entry("approvals", "page", "/portal/approvals", {
    requiredPermission: P.APPROVAL_REVIEW,
    ...SCHOOL,
  }),

  // The school's feature license.
  entry("license", "page", "/portal/license", LICENSE),
  entry("license-seats", "page", "/portal/license/seats", LICENSE),
  entry("license-quotes", "page", "/portal/license/quotes", LICENSE),
  entry("license-invoices", "page", "/portal/license/invoices", LICENSE),

  // Tuition finance.
  entry("finance-dashboard", "page", "/portal/finance", FINANCE_REPORTS),
  entry("finance-overdue", "page", "/portal/finance/overdue", FINANCE_REPORTS),
  entry("add-fee-structure", "action", "/portal/finance/fees", BILLING_UPDATE),
  entry("invoices", "page", "/portal/finance/invoices", BILLING_READ),
  entry("create-invoice-batch", "action", "/portal/finance/invoices/batches/new", BILLING_UPDATE),
  entry("families", "page", "/portal/finance/families", BILLING_READ),
  entry("unlinked", "page", "/portal/finance/unlinked", BILLING_READ),
  entry("payments", "page", "/portal/finance/payments", BILLING_READ),
  entry("record-payment", "action", "/portal/finance/payments/new", BILLING_UPDATE),
  entry("refunds", "page", "/portal/finance/adjustments/refunds", BILLING_READ),
  entry("issue-refund", "action", "/portal/finance/adjustments/refunds/new", BILLING_UPDATE),
  entry("scholarships", "page", "/portal/finance/scholarships", BILLING_READ),
  // Awarding needs `billing:update` and an active scholarship; the page checks both.
  entry("request-scholarship", "action", "/portal/finance/scholarships?award=1", {
    ...BILLING_READ,
    alsoRequires: [P.BILLING_UPDATE],
  }),
  entry("finance-reports", "page", "/portal/finance/reports", FINANCE_REPORTS),
  entry("expenses", "page", "/portal/finance/expenses", BILLING_READ),
  entry("record-expense", "action", "/portal/finance/expenses/new", BILLING_UPDATE),
];

const BY_ID = new Map(SEARCH_DESTINATIONS.map((destination) => [destination.id, destination]));

export function destinationById(id: string): SearchDestination | undefined {
  return BY_ID.get(id);
}

function groupOf(destination: SearchDestination): string {
  return destination.variantOf ?? destination.id;
}

function canOpen(destination: SearchDestination, permissions: ReadonlySet<Permission>): boolean {
  const isPlatformOperator = permissions.has(PERMISSIONS.PLATFORM_READ);
  if (isPlatformOperator && destination.schoolScoped) return false;
  if (destination.requiredPermission && !permissions.has(destination.requiredPermission)) {
    return false;
  }
  if (destination.alsoRequires && !destination.alsoRequires.every((p) => permissions.has(p))) {
    return false;
  }
  if (destination.alsoRequiresAny && !destination.alsoRequiresAny.some((p) => permissions.has(p))) {
    return false;
  }
  return true;
}

/**
 * The destinations a session holding `permissions` can open: the route's permission and the page's
 * own checks held, school-scoped ones dropped for a platform operator (as `visiblePortalNavItems`
 * does), and one entry per `variantOf` group — the first in registry order.
 */
export function visibleDestinations(
  permissions: ReadonlySet<Permission>,
): readonly SearchDestination[] {
  const seenGroups = new Set<string>();
  const visible: SearchDestination[] = [];
  for (const destination of SEARCH_DESTINATIONS) {
    if (!canOpen(destination, permissions)) continue;
    const group = groupOf(destination);
    if (seenGroups.has(group)) continue;
    seenGroups.add(group);
    visible.push(destination);
  }
  return visible;
}

/**
 * The entry a session should be sent to for `id` — itself, or its counterpart in the portal the
 * session can open (`build-timetable` → the principal's timetable for a principal). Undefined when
 * the session can open neither; a help article's link then has nowhere to go and should be hidden.
 */
export function resolveDestination(
  id: string,
  permissions: ReadonlySet<Permission>,
): SearchDestination | undefined {
  const target = BY_ID.get(id);
  if (!target) return undefined;
  const group = groupOf(target);
  return visibleDestinations(permissions).find((candidate) => groupOf(candidate) === group);
}

/**
 * What each kind of staff member comes to do, most useful first, for the palette's empty state. The
 * first profile whose permission the session holds wins; ids are canonical and resolved per
 * session, so the principal's list names `build-timetable` and gets their own timetable page.
 */
const SUGGESTION_PROFILES: readonly { when: Permission; ids: readonly string[] }[] = [
  {
    when: P.PLATFORM_READ,
    ids: [
      "review-school-applications",
      "look-up-account",
      "build-license-quote",
      "review-platform-refunds",
    ],
  },
  {
    when: P.ORGANIZATION_MANAGE_SETTINGS,
    ids: [
      "add-student",
      "invite-staff",
      "import-students",
      "link-parent",
      "build-timetable",
      "create-announcement",
    ],
  },
  {
    when: P.PRINCIPAL_DASHBOARD_VIEW,
    ids: [
      "set-up-academics",
      "build-timetable",
      "create-announcement",
      "add-calendar-event",
      "start-evaluation",
      "build-record-templates",
    ],
  },
  {
    when: P.BILLING_UPDATE,
    ids: [
      "create-invoice-batch",
      "record-payment",
      "issue-refund",
      "record-expense",
      "request-scholarship",
      "add-fee-structure",
    ],
  },
  {
    when: P.ATTENDANCE_RECORD_CREATE,
    // An officer has only two tasks of their own; their reports and the calendar round it out.
    ids: ["take-attendance", "correct-attendance", "attendance-reports", "school-calendar"],
  },
];

const MIN_SUGGESTIONS = 4;
const MAX_SUGGESTIONS = 6;

/**
 * 4–6 destination ids for the palette's empty state, as resolved for this session (so each can be
 * opened). Actions first; a session whose profile yields fewer than four is padded with its other
 * visible actions in registry order. A session with no actions at all gets none.
 */
export function suggestedActions(permissions: ReadonlySet<Permission>): readonly string[] {
  const profile = SUGGESTION_PROFILES.find((candidate) => permissions.has(candidate.when));
  const ids: string[] = [];
  for (const id of profile?.ids ?? []) {
    const resolved = resolveDestination(id, permissions);
    if (resolved && !ids.includes(resolved.id)) ids.push(resolved.id);
  }
  if (ids.length < MIN_SUGGESTIONS) {
    for (const destination of visibleDestinations(permissions)) {
      if (ids.length >= MIN_SUGGESTIONS) break;
      if (destination.kind === "action" && !ids.includes(destination.id)) ids.push(destination.id);
    }
  }
  return ids.slice(0, MAX_SUGGESTIONS);
}

/** Splits a catalog keyword string on `,` and the Arabic comma `،`. */
export function splitKeywords(value: string): string[] {
  return value
    .split(/[,،]/)
    .map((keyword) => keyword.trim())
    .filter((keyword) => keyword.length > 0);
}

/** A translator: i18next's `t`, or `i18next.getFixedT(lng)`. */
export type Translate = (key: string) => string;

// Field weights: a hit in the title counts most, then a keyword, then the breadcrumb.
const TITLE_WEIGHT = 3;
const KEYWORD_WEIGHT = 2;
const WHERE_WEIGHT = 1;
/** A last-token prefix hit ("acad" → "academics") counts for this share of a whole-word hit. */
const PREFIX_FACTOR = 0.6;
/** The shortest last token that may match as a prefix; a single letter matches only itself. */
const MIN_PREFIX_LENGTH = 2;

// Bonuses for the whole query matching a whole title or keyword phrase; the best one counts.
const TITLE_EXACT_BONUS = 12;
const TITLE_START_BONUS = 8;
const TITLE_WORD_BONUS = 6;
const KEYWORD_EXACT_BONUS = 8;
const KEYWORD_START_BONUS = 4;
const KEYWORD_WORD_BONUS = 2;

/**
 * Arabic's definite article is written onto the word, so "الطالب" and "طالب" are the same word to
 * someone searching. Compared without it (only on words long enough to carry it).
 */
function withoutArticle(token: string): string {
  return token.length > 3 && token.startsWith("ال") ? token.slice(2) : token;
}

interface Haystack {
  readonly title: string;
  readonly titleTokens: readonly string[];
  readonly keywords: readonly string[];
  readonly keywordTokens: readonly string[];
  readonly whereTokens: readonly string[];
}

function haystackFor(destination: SearchDestination, t: Translate): Haystack {
  // i18next returns the key itself for a string that is missing (a catalog not loaded yet).
  const resolve = (key: string | undefined) => {
    if (!key) return "";
    const value = t(key);
    return value === key ? "" : value;
  };
  const title = normalizeSearchText(resolve(destination.titleKey));
  const keywords = splitKeywords(resolve(destination.keywordsKey)).map(normalizeSearchText);
  return {
    title,
    titleTokens: searchTokens(title),
    keywords,
    keywordTokens: keywords.flatMap((keyword) => searchTokens(keyword)),
    whereTokens: searchTokens(resolve(destination.whereKey)),
  };
}

function tokenHit(queryToken: string, tokens: readonly string[], allowPrefix: boolean): number {
  const bare = withoutArticle(queryToken);
  let best = 0;
  for (const token of tokens) {
    if (token === queryToken || withoutArticle(token) === bare) return 1;
    if (allowPrefix && (token.startsWith(queryToken) || withoutArticle(token).startsWith(bare))) {
      best = PREFIX_FACTOR;
    }
  }
  return best;
}

/** Whether `phrase` starts with the words of `query` (or contains them from a word start). */
function phraseBonus(
  phrase: string,
  query: string,
  exact: number,
  start: number,
  word: number,
): number {
  if (!phrase) return 0;
  if (phrase === query) return exact;
  if (phrase.startsWith(query)) return start;
  if (` ${phrase}`.includes(` ${query}`)) return word;
  return 0;
}

function scoreIn(haystack: Haystack, queryTokens: readonly string[], query: string): number {
  let score = 0;
  for (const [index, queryToken] of queryTokens.entries()) {
    const allowPrefix = index === queryTokens.length - 1 && queryToken.length >= MIN_PREFIX_LENGTH;
    const best = Math.max(
      TITLE_WEIGHT * tokenHit(queryToken, haystack.titleTokens, allowPrefix),
      KEYWORD_WEIGHT * tokenHit(queryToken, haystack.keywordTokens, allowPrefix),
      WHERE_WEIGHT * tokenHit(queryToken, haystack.whereTokens, allowPrefix),
    );
    // Every word of the query has to be found somewhere.
    if (best === 0) return 0;
    score += best;
  }
  const bonus = Math.max(
    phraseBonus(haystack.title, query, TITLE_EXACT_BONUS, TITLE_START_BONUS, TITLE_WORD_BONUS),
    ...haystack.keywords.map((keyword) =>
      phraseBonus(keyword, query, KEYWORD_EXACT_BONUS, KEYWORD_START_BONUS, KEYWORD_WORD_BONUS),
    ),
  );
  return score + bonus;
}

/**
 * Ranks `destinations` against `query`, best first, dropping those that do not match. Pure: every
 * string comes through `t`. Pass one translator per language to match in (see
 * {@link searchTranslators}) — so an Arabic UI user typing "timetable", or an English one typing
 * "الجدول", still finds the page; each destination scores its best language.
 *
 * Matching uses {@link normalizeSearchText}'s rules: every query word must appear in the title,
 * keywords or breadcrumb, the last one may be a prefix ("acad"), and a title hit outweighs a keyword
 * hit, which outweighs a breadcrumb hit. Ties keep registry order.
 */
export function rankDestinations(
  query: string,
  destinations: readonly SearchDestination[],
  t: Translate | readonly Translate[],
): SearchDestination[] {
  const queryTokens = searchTokens(query);
  if (queryTokens.length === 0) return [];
  const normalizedQuery = queryTokens.join(" ");
  const translators = typeof t === "function" ? [t] : t;
  return destinations
    .map((destination, order) => ({
      destination,
      order,
      score: Math.max(
        0,
        ...translators.map((translate) =>
          scoreIn(haystackFor(destination, translate), queryTokens, normalizedQuery),
        ),
      ),
    }))
    .filter((ranked) => ranked.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map((ranked) => ranked.destination);
}

/**
 * Translators for `rankDestinations`: the given (active) language first, then every other language
 * the app ships — so an Arabic UI user typing "timetable" and an English one typing "الجدول" both
 * find it.
 */
export function searchTranslators(language: string = i18next.language): Translate[] {
  const languages = [...new Set([language, ...SUPPORTED_LOCALES])];
  return languages.map((lng) => {
    const fixed = i18next.getFixedT(lng);
    return (key: string) => fixed(key);
  });
}

/**
 * Loads the destinations' strings in every language {@link searchTranslators} matches against.
 * Await before ranking (the palette does on open); each language's file loads once per session.
 */
export function loadSearchDestinationCatalogs(): Promise<void> {
  return loadCatalogAreasIn([i18next.language, ...SUPPORTED_LOCALES], [SEARCH_CATALOG_AREA]);
}
