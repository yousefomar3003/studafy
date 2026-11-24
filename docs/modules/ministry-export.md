# Ministry results export

Schools in Jordan and the wider Arab region send their results to the ministry of education (or a
platform such as Noor or eSIS) in the ministry's own columns, codes and file type. Those formats
differ from country to country and change from year to year, so Studafy does not hard-code any of
them: a school keeps **export templates** it edits, and exports a year's finalized results through
one, with a preview and a check of what is missing before the file goes out.

- Plan: [`docs/plans/academic-phase2.md`](../plans/academic-phase2.md), WS-L
- Migration: `db/migrations/000265_create_ministry_export_templates.sql`
- Layout and checks: `packages/grading-engine/src/ministry-export.ts` (`buildMinistryExport`,
  `validateMinistryExportTemplate`, the field list and the built-in examples)
- API: `apps/api/src/modules/ministry-export` (tag "Ministry export"); the file itself is
  `file.ts` (CSV and XLSX)
- Web: Academic setup › Ministry export (`MinistryExportTab.tsx`): templates, examples, the editor,
  and the preview and download for the selected year
- Mobile: none. Leadership works on the web only.

The feature is opt-in: a school that adds no template sees an empty tab and nothing else changes.

## Data model

| Table                               | One row per                                                                        |
| ----------------------------------- | ---------------------------------------------------------------------------------- |
| `app.ministry_export_templates`     | template: name, target, file type, encoding, row kind, decimals, national ID field |
| `app.ministry_export_columns`       | column of a template, in file order: heading, field, fixed text                    |
| `app.ministry_export_value_maps`    | value translation of a column: our value → the ministry's                          |
| `app.ministry_export_subject_codes` | the ministry's code for one of the school's subjects, per template                 |

- **Template**: `name` (unique per school, case-insensitively), `target` (free label, "Jordan
  MoE"), `file_format` (`csv`, `xlsx`), `encoding` (`utf8`, `utf8_bom`; a CSV only — Excel needs the
  byte-order mark to read Arabic), `row_kind` (`subject`: one row per student per subject;
  `overall`: one row per student), `decimal_places` (0–3, default 2, for marks, percentages and
  GPAs, rounded half up), `national_id_field_id` (the student record field holding the national ID,
  nullable).
- **Column**: `position`, `header`, `field` (one of the fields below, held to that set by a CHECK),
  `constant_value` (`constant` columns only).
- Columns, value maps and subject codes are child tables with composite foreign keys rather than a
  JSON document: a subject or record field cannot disappear from under a template (`ON DELETE
RESTRICT`), and the RLS coverage check needs no flexible-column approval. Saving a template
  replaces its columns, value maps and subject codes; deleting it deletes them.
- Tenant isolation on all four tables (ADR-015). Nothing per student is stored.

### Fields

| Field                          | Per-subject row                                  | Overall row                                           |
| ------------------------------ | ------------------------------------------------ | ----------------------------------------------------- |
| `national_id`                  | the template's record field (see below)          | same                                                  |
| `admission_number`             | the student number                               | same                                                  |
| `first_name` … `full_name`     | the student's current English names              | same                                                  |
| `date_of_birth`                | `YYYY-MM-DD`                                     | same                                                  |
| `grade_level`, `section`       | the section the result was finalized in          | same                                                  |
| `academic_year`, `term`        | the year's name; the term's name, or `Annual`    | same                                                  |
| `subject_code`, `subject_name` | the school's subject code and name               | not allowed                                           |
| `subject_ministry_code`        | the template's code for the subject              | not allowed                                           |
| `mark`, `max_mark`             | marks obtained and the maximum                   | total obtained and total maximum                      |
| `percentage`                   | the subject percentage                           | the overall average                                   |
| `grade_label`                  | the subject's grade label                        | the overall grade label                               |
| `gpa`                          | the subject's GPA points                         | the overall GPA, when the grade's result is a GPA     |
| `status`                       | `pass`, `fail`, `incomplete`, `exempt`           | `promoted`, `supplementary`, `retained`, `incomplete` |
| `constant`                     | the column's fixed text (a school code, a stage) | same                                                  |

A **value map** turns a column's formatted value into the ministry's (`pass = 1`, `B+ = 7`,
`Annual = 3`); a value it does not list is written as it is. A fixed-text column takes none.

**Arabic names** (WS-K, migration 000264) are not fields yet: once students and subjects carry
them, add `first_name_ar`, `middle_name_ar`, `last_name_ar`, `full_name_ar` and `subject_name_ar`
to `MINISTRY_EXPORT_FIELDS`, to `ck_ministry_export_columns_field` in a new migration, to the
source row and to the API's row query. The extension point is marked in `ministry-export.ts` and in
the migration.

## Built-in examples

`GET /api/grading/ministry-export-examples` returns three starting points — results by subject
(CSV), overall results (XLSX) and Arabic headings by subject (CSV) — each named "(example)" and
carrying a note that it is **an editable example, not an official ministry format**. The web copies
one into a new template the school edits and saves; nothing is created until it does.

## Running an export

`POST /api/grading/ministry-exports/preview` and `.../download` take a template, an academic year,
a term or `null` for the year's annual results, and optionally grade levels and sections (none:
all of the year's sections).

- **Finalized results only**: each section's **current** finalization for the period (a correction
  supersedes the old one). A section with none is left out and reported as `section_not_finalized`.
- Figures come from the finalized snapshot (ADR-017); names, codes, grade and section names are the
  school's current ones, as a ministry wants them.
- Rows are in grade, section, then student order (last name, first name, number), and by subject
  code within a student.
- The **preview** returns the heading, the first 20 rows exactly as the file will have them, the row,
  student and section counts, and a validation report:

  | Code                         | Severity | Meaning                                                         |
  | ---------------------------- | -------- | --------------------------------------------------------------- |
  | `national_id_source_missing` | error    | the template has a national ID column but names no record field |
  | `missing_national_id`        | error    | one per student without a national ID (`count` rows)            |
  | `unmapped_subject`           | error    | one per subject without a ministry code (`count` rows)          |
  | `section_not_finalized`      | warning  | one per active section with no finalized result for the period  |

  The report never blocks the download: the school decides.

- The **download** is the whole file: CSV (RFC 4180, CRLF, every cell through `csvCell`, so text
  that looks like a formula is neutralised; with a byte-order mark for `utf8_bom`) or XLSX (one
  "Results" sheet, numeric fields as numbers unless a value map changes them, every other column
  text-formatted so IDs keep their leading zeros). The file name is an ASCII slug of the template
  name, the year code and the term.

## The national ID and its access rules

Studafy has no national ID column. A school keeps it in its own **student records**
([ADR-019](../adr/0019-sensitive-record-field-encryption.md)), usually as a **sensitive** field, so
the template names that field (`national_id_field_id`; a short text or number student field, not
archived), and the export reads it with the records module's rules:

- Reading it at all needs `studentRecord:read` (403 otherwise).
- A **sensitive** value is never decrypted for a preview: the preview shows each value's mask
  (`•••• 4567`) and says so (`national_ids_masked`).
- The **download** opens sensitive values only for a caller holding `studentRecord:readSensitive`
  (403 otherwise), with the records keyring and the same additional authenticated data as a reveal;
  a value the keys cannot open is a 503 `RECORD_KEY_UNAVAILABLE`, never a plaintext fallback. A value
  sealed under a field that has since become standard still needs the permission.
- The download is **audited like a reveal**: one `read` row on `record_fields` (the field) with
  `reveal: true`, `purpose: "ministry_export"`, the template and the ids of the students whose
  values were opened — never a value — next to the download's own `export` row.

This makes the download a third path that decrypts sensitive values, beside the reveal endpoint and
the DSR export; ADR-019 is amended to say so.

## Access

| Route                                                        | Permission              |
| ------------------------------------------------------------ | ----------------------- |
| `GET /api/grading/ministry-export-examples`                  | `academicConfig:manage` |
| `GET`, `POST /api/grading/ministry-export-templates`         | `academicConfig:manage` |
| `PUT`, `DELETE /api/grading/ministry-export-templates/{id}`  | `academicConfig:manage` |
| `POST /api/grading/ministry-exports/preview`, `.../download` | `result:finalize`       |

All of them are school leadership's (`ORG_ADMIN`, `PRINCIPAL`), from **web sessions only**
(`CHANNEL_NOT_AUTHORIZED` on a mobile or API token), like the records reveal. Template writes are
audited with old and new values; each download with an `export` row (year, term, grades,
sections, finalizations, file type, rows, students, issues and how many sensitive IDs were opened).

## Tests

- `packages/grading-engine/src/ministry-export.test.ts`: validation, number formatting, value maps,
  every field's layout, the validation report, the examples.
- `apps/api/src/modules/ministry-export/file.test.ts`: CSV quoting, formula safety and the BOM;
  XLSX cell types; file names.
- `apps/api/src/modules/ministry-export/__tests__/ministry-export.integration.test.ts`: templates
  and their checks, leadership-only and web-only access, the masked preview and its report, the
  download with full IDs and its audit rows, an overall XLSX export of annual results, and another
  school seeing none of it.
- `apps/web/src/features/principal/academic-setup/MinistryExportTab.test.tsx`: the list, starting
  from an example, the editor's checks, the preview and the download.
