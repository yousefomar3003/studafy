# Global search

One search box (the header's **Search**, or Ctrl+K / ⌘K on any portal page) finds everything a
person can open: pages ("Go to"), tasks ("Do"), help articles ("How to") and records (students,
invoices, classes and 17 more types). It works in English and Arabic, with keywords and synonyms,
prefix matching as you type, and typo tolerance for names.

Search shows only what the person can open. That is a convenience, not security: every route keeps
its `RequirePermission` and every API endpoint its own guard and row-level security.

| Piece                         | Where                                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------------------------- |
| Palette                       | `apps/web/src/features/search/SearchPalette.tsx` (in `PortalHeader` via `GlobalSearchTrigger`) |
| Pages and tasks registry      | `apps/web/src/features/search/destinations.ts`, strings in `locales/{en,ar}/search.json`       |
| Help search                   | `apps/web/src/features/help/content.ts` (`searchHelpArticles`), articles in `docs/help`        |
| Role-aware record links       | `apps/web/src/features/search/record-links.ts`                                                 |
| Full results page             | `/portal/search?q=&type=&page=` (`SearchResultsPage.tsx`)                                      |
| Normalization (client)        | `apps/web/src/features/search/normalize.ts`                                                    |
| Record search API             | `GET /api/search`, `apps/api/src/modules/search`                                               |
| Search columns, normalization | `db/migrations/000110_*.sql` (first four types), `000171_extend_global_search.sql`             |

## The palette

Groups, in this order, each shown only when it has a match, best match first:

1. **Go to**: pages from the registry (4 at most).
2. **Do**: tasks from the registry (4 at most). A task opens the place it is done, in the right state:
   "Add a student" opens Students with the create form open (`?create=1`).
3. **How to**: help articles (3 at most), linking to `/help/<slug>`, or to `/help/<slug>#<heading>`
   when the match is inside a section.
4. **Records**, one group per type in the API's order (5 per type). When a type has more matches,
   a **See all N results** row opens the full results page filtered to that type.

The first three are ranked on the client on every keystroke, with no API call. Records follow from
`GET /api/search` after a 300 ms pause. The registry strings (in every language) and the help
catalogue load when the palette first opens, on whatever portal page that is; neither is in the
entry bundle.

- **Empty box**: recent searches (kept in this browser only) and 4 to 6 suggested tasks for the
  person's role (`suggestedActions`).
- **No results**: the registry entries closest to what was typed ("timtable" offers Timetable) and a
  link to the help center.
- **One type only**: type `in:<type>` before or after the words, e.g. `in:invoices inv-00`
  (`scoped-query.ts`; API type names plus a few aliases such as `in:student`, `in:fees`).
- **Keyboard**: focus stays in the box; ↑ ↓ Home End move through every selectable row across the
  groups (`aria-activedescendant`), Enter opens it, Esc closes. Rows with nowhere to go (a
  material) are shown but skipped.

The full results page has a chip per type with a match (with counts), "See all" per group, and
pages of 20 for one type. Its URL holds the query, type and page, so it can be shared.

## What is searched, per role

**Pages, tasks and help** are the same for everyone, narrowed per session:

- registry entries whose `requiredPermission` (exactly the route's) and the page's own extra checks
  (`alsoRequires`) the session holds; platform operators (`platform:read`) never see school-scoped
  entries, as in the sidebar (`visiblePortalNavItems`);
- where the same task exists in two portals (the admin's and the principal's timetable), only the
  first one the session can open;
- help articles are public and never hidden. An article's `roles` frontmatter only ranks it higher
  for those roles (finance articles first for FINANCE).

**Records** (`GET /api/search`): each type runs only when the caller holds the permission its own
list endpoint requires, and returns only the rows that endpoint's row-level security would.
The response always has every type, empty when not permitted.

| Type                                                                    | Who gets it                                                             | Rows                                                                        |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| students                                                                | `student:read`                                                          | RLS: admins all; a teacher their classes' students; a parent their children |
| users                                                                   | `user:read`                                                             | the school                                                                  |
| invoices                                                                | `billing:read`                                                          | the school; matches the invoice number only (see below)                     |
| materials                                                               | `material:read`                                                         | RLS: classes the caller can read                                            |
| classes, sections, subjects, grade levels, academic years, terms, rooms | everyone (their list endpoints gate only writes)                        | RLS narrows classes and subjects to what the caller teaches or runs         |
| families                                                                | PARENT, `parent:link` or `billing:read`                                 | a parent sees only their own family                                         |
| announcements                                                           | `notification:manage`                                                   | the school                                                                  |
| calendar events                                                         | `calendarEvent:read`                                                    | the school                                                                  |
| discipline incidents                                                    | `principalDashboard:view` and `disciplineIncident:read`, never a PARENT | title only; descriptions are never searched                                 |
| evaluations                                                             | `evaluation:read`                                                       | RLS: evaluations the caller wrote; a teacher their own shared ones          |
| fee structures, expenses                                                | `billing:update` (the gate on their list endpoints)                     | the school                                                                  |
| scholarships                                                            | `billing:read`                                                          | the school                                                                  |
| notifications                                                           | everyone                                                                | the caller's own                                                            |

Invoices, families and fee structures match only on their own columns, never a joined student or
parent name, and join those with `LEFT JOIN`. A FINANCE user cannot read student rows under RLS, so
matching on (or inner-joining) the student would make the finance records vanish for exactly the
people they are for. The joined name is shown when RLS allows it and is null otherwise.

Only names, titles, codes and document numbers are searchable. Never bodies, descriptions,
narratives or payloads, and never school-defined record answers (template values, documents,
anything sensitive): see [student-records.md](student-records.md). `tests/records/record-data-boundary.test.ts`
fails if the search module names a record table, and the search integration test checks that a
stored record value is never found.

Every call writes a `read` audit entry against `global_search`: the query text, limit, offset,
requested types, the sections that ran and their counts. Never a hit's values.

## Matching rules

The same rules run in SQL (`app.search_normalize`) and on the client (`normalizeSearchText`); the
two must change together.

- Lowercase; Arabic diacritics (U+064B–U+065F, U+0670) and tatweel (U+0640) removed; أ إ آ ٱ → ا;
  ى → ي; ة → ه; whitespace collapsed. So أحمد finds احمد and مُحَمَّد finds محمد.
- The query is split into letter/digit words; every word must match, the last one as a prefix while
  typing: "oma" finds Omar, "inv-00" finds INV-0012. The stored search text has punctuation folded to spaces
  so it splits the same way.
- Names and titles of students, users, classes, subjects and families fall back to trigram
  similarity when nothing matches exactly, with a floor of 0.5 (`word_similarity`): "mohamad"
  finds Mohammed and "fatma" finds Fatima, but a short query like "math" does not drag in every
  Mariam.
- For students, classes and subjects (the row-scoped types), "nothing matches exactly" means
  nothing in the whole school, not only in what the caller can see. If the name exists but is
  outside the caller's scope (a teacher searching a student in another class), it is not a typo:
  the section is empty and the fallback does not run. A typo of a name in the caller's own scope
  still falls back, as long as no name in the school starts with what was typed. Users and families
  keep the plain rule, because their exact match is already school-wide.
- On the client, Arabic words also match without the definite article (الطالب ~ طالب), and the
  registry matches in both languages whatever the interface language, so an Arabic-language user
  typing "timetable" still finds the page.
- Query text is always a bound parameter; the API only ever builds a tsquery from letter/digit
  tokens. Every input is in `tests/security/sql-injection.test.ts`.

**Performance.** There are no search indexes. Every searched table has FORCE RLS, and PostgreSQL
will not use an index for `@@` or the trigram `<%` ahead of the policy check, because neither
operator is leakproof. A GIN or trigram index would never be used and would only add write and disk
cost, so migration 000171 creates none (its header, point 4). Instead, each section's scan is
bounded by the tenant's `school_id` btree, and the match is a filter over that one school's rows,
read from stored generated columns (`search_tsv`, `search_name`), so no row is re-tokenized at query
time. For the row-scoped types (students, classes, subjects, materials), the API first asks
`app.search_scoped_ids` (SECURITY DEFINER, tenant isolation still applies, ids only) for the
matching ids, then reads each of those rows under the caller's RLS. Every returned and counted row
is still decided by RLS. The admin check in those tables' policies runs once per query, not once per
row. At 5,000 students
(`GLOBAL_SEARCH_BENCHMARK=1 bun test tests/benchmark/global-search-benchmark.test.ts`), p95 is
87–130 ms for an org admin and 125–145 ms for a teacher. A teacher's p95 rises to about
195–220 ms when a name query matches nobody in the teacher's own classes. Then the trigram fallback
runs over every similar name in the school, and each of those candidates pays the per-row policy
predicate. The benchmark hits this case whenever its random class roster contains no match.
`tests/search/global-search-plans.integration.test.ts` checks the query plans, and fails if a
search index is added. `tests/search/global-search-policy-equivalence.integration.test.ts` checks
that 000171's policy rewrite shows every caller the same rows as before.

## Adding a page

Every authenticated page without a `:param` needs a registry entry; the pin test
(`destinations.test.ts`) fails otherwise. It walks the real route tree, including the academic
setup sub-pages.

1. Add an `entry(id, "page" | "action", route, options)` to `SEARCH_DESTINATIONS`:
   - `requiredPermission`: exactly the route's `RequirePermission` (the test checks it);
   - `schoolScoped`, as in `nav-items.ts`;
   - `alsoRequires`/`alsoRequiresAny`: checks the page itself makes before offering the task;
   - `variantOf`: the canonical id, when the same task lives in another portal.
2. Add `search.destinations.<id>.title`, `.where` (the breadcrumb, e.g. "Principal › Academic setup
   › Subjects") and `.keywords` to **both** `locales/en/search.json` and `locales/ar/search.json`.
3. If the entry is a task that opens a form, make the page read a URL param (`?create=1`) with
   `useSearchParamFlag`, and drop it with replace when the form closes. That way opening the URL
   directly does the same thing, and Back does not reopen it.
4. A page that must not be searchable goes in the test's `EXEMPT` list with a reason.

Pages with a `:param` (a student's profile) are reached through record results. For a new record
type, add a section to the API (permission gate, a generated `search_tsv` column in a migration,
with no index (see Performance), a named hit schema) and a row in `RECORD_LINK_CANDIDATES` in
`record-links.ts`. Each candidate lists
its route's exact permission; `record-links.test.ts` checks it against the route tree and checks
that no link points at a route the role cannot open.

## Adding keywords

Keywords are a comma-separated string (`,` or the Arabic `،`) under
`search.destinations.<id>.keywords`, 5 to 15 per language (the pin test enforces it). Use the words
staff actually type, not translations of the title. For Academic setup: "academic framework,
curriculum, grading system, grade scale, subjects setup". For linking a parent: "guardian, mother,
father, family, connect parent". Arabic keywords should be natural school vocabulary, not
transliteration. Hamza and diacritics don't matter (normalization handles them). Run
`bun run i18n:pseudo` in `apps/web` after editing the catalogs.

Help articles carry their own keywords in frontmatter (`keywords`, `keywords_ar`). Every published
article needs `title_ar`, `description_ar` and `keywords_ar`, and may name the registry task it
walks through (`action: add-student`), which shows a **Do it now** button to readers who can open
it. See [docs/help/README.md](../help/README.md).

## Out of scope

The mobile app, AI or semantic search (the RAG module is separate), school-defined custom keywords,
and searching inside uploaded files.
