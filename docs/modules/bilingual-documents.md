# Arabic + English documents

Schools in Jordan and the region issue report cards, certificates and transcripts in Arabic, in
English, or in both. Studafy keeps an optional Arabic spelling beside the English names a school
already has, and lets the school choose, per document type, the language a document is issued in.

- Migration: `db/migrations/000264_bilingual_names_and_document_language.sql`
- API: `apps/api/src/modules/grading/document-language-service.ts`,
  `routes/document-language-routes.ts` (tag "Results"); Arabic names on the academics and student
  routes; snapshots in `certificate-service.ts` and `transcript-service.ts`
- Web: Academic setup > Report cards ("Document language", with a preview); Arabic names on the
  student create/edit forms, Subjects & courses, Grades & sections
  (`apps/web/src/features/principal/academic-setup/document-language.tsx` renders documents)
- Mobile: `apps/mobile/lib/src/core/localization/localized_name.dart`
- Plan: [`docs/plans/academic-phase2.md`](../plans/academic-phase2.md), WS-K

## Arabic names

| Table                | Columns                                           |
| -------------------- | ------------------------------------------------- |
| `app.students`       | `first_name_ar`, `middle_name_ar`, `last_name_ar` |
| `app.subjects`       | `name_ar`                                         |
| `app.grade_levels`   | `name_ar`                                         |
| `app.sections`       | `name_ar`                                         |
| `app.schools`        | `name_ar`                                         |
| `app.terms`          | `name_ar`                                         |
| `app.academic_years` | `name_ar`                                         |

All optional (NULL = none; trimmed and non-blank when set; 100 characters for a person's name, 200
otherwise). Every reader falls back to the English name. On the API they are read and written
with the entity: an omitted field keeps its value, `null` or blank clears it. A course read
(`GET /api/academics/courses...`), a published grade's course, the parent's child timetable, a
finalized result's subjects and released marks carry the subject's Arabic name
(`subject_name_ar`), so apps in Arabic can show it.

`app.subjects` is role-scoped (000037): a student or parent may not read the subject row behind a
result they can read. `app.subject_names_ar(uuid[])` (SECURITY DEFINER, tenant-scoped) returns only
the Arabic names of the subjects asked for, and does not widen the policy.

**Search.** The admin student list (`GET /api/students?search=`) matches the Arabic first and last
names. The global search (`GET /api/search`) matches a student's Arabic name by full text and by
typo: `app.search_scoped_ids` / `app.search_scoped_fuzzy_ids` and the API's re-check add an
Arabic-name disjunct evaluated on the fly, only for students who have one. The stored
`search_tsv` / `search_name` columns (000171) are unchanged: changing a generated column would
mean rewriting `app.students`.

**Imports.** The student import accepts `first_name_ar`, `middle_name_ar` and `last_name_ar` (see
the [mapping guide](student-import-mapping-guide.md)).

**Privacy.** A DSR export copies whole rows, so the Arabic names are in it. Erasure redacts
`first_name_ar`, `middle_name_ar` and `last_name_ar` with the student's other names
(`PII_COLUMN_PATTERNS`, `apps/workers/src/queues/maintenance/retention-registry.ts`). `name_ar` on
catalogue tables is a label, not personal data.

## Document language

`app.document_language_settings` (one row per school, tenant isolation only), edited through
`GET/PUT /api/grading/document-language-settings` (`academicConfig:read` / `academicConfig:manage`,
audited), together with the school's Arabic name:

| Field                  | Document             | Values                                      |
| ---------------------- | -------------------- | ------------------------------------------- |
| `report_card_language` | term report cards    | `viewer` (default), `en`, `ar`, `bilingual` |
| `certificate_language` | annual certificates  | same                                        |
| `transcript_language`  | academic transcripts | same                                        |

`viewer` is the behaviour before this feature: no language is stored and each reader sees the
document in their own language. No row means `viewer` for all three.

## Issued documents

Issuing a certificate, report card or transcript copies into its immutable `content` (ADR-017):

- `language` (`en`, `ar` or `bilingual`) when the school chose one; absent for `viewer`;
- the Arabic names at that moment, each only when there is one: `school.name_ar`,
  `academic_year.name_ar`, `term.name_ar`, `student.first_name_ar` / `middle_name_ar` /
  `last_name_ar`, `grade_level_name_ar`, `section_name_ar`, `subjects[].name_ar`,
  `subjects[].terms[].term_name_ar`; on a transcript, per year `academic_year.name_ar`,
  `grade_level_name_ar`, `section_name_ar` and `subjects[].name_ar`.

These are additions: documents issued before have none of them and render exactly as before.
Renaming a subject or changing the setting later never changes an issued document; a reissue
renders afresh.

**Web.** `DocumentLanguageScope` gives the document a translation instance fixed to `en` or `ar`
(labels, result formats and every shared piece follow), sets `dir="rtl"` and `lang="ar"` on an
Arabic document, and prints both labels ("Subject / المادة") and both names on a bilingual one.
Without a language it uses the reader's, with Arabic names when the reader is in Arabic. Arabic
text prefers Noto Sans Arabic, the face the server PDFs embed, when it is installed. The
"Document language" card previews a sample document in the chosen language.

**Mobile.** One helper, `context.localizedName(name, nameAr)`, picks the Arabic spelling when the
app is in Arabic (results, released marks, grades, timetable and materials headers). Inside an
issued document (`DocumentLanguageScope`) it follows the document's language instead, and an
Arabic or English document lays out in its own direction. The app's labels stay in the app's
language: the app ships one locale's strings at a time.
