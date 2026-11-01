# Custom lists

A school keeps data Studafy has no section for as its own **custom lists**: bus routes, library
loans, clinic visits, lockers, uniform orders, alumni. A list is a school-defined table with typed
columns, and each row may point to a student, a parent, a member of staff or a class. A sheet in an
import that matches nothing Studafy knows can become a list in a few clicks.

- Migration: `db/migrations/000182_create_custom_lists.sql`
- API: `apps/api/src/modules/custom-lists` (tag "Custom lists")
- Privacy: `apps/workers/src/queues/maintenance/records-dsr.ts`
- Help article: `docs/help/getting-started/keep-your-own-lists.md`

Custom lists reuse the school record fields' vocabulary ([student-records.md](./student-records.md),
ADR-019): the same field types, the same sensitivity, the same value validation
(`normalizeRecordValue`) and the same sealing.

## Data model

| Table                            | One row per                                                       |
| -------------------------------- | ----------------------------------------------------------------- |
| `app.custom_lists`               | list: `name_en`, `name_ar`, `description`, `audience`, link kinds |
| `app.custom_list_columns`        | column: `field_type`, labels, `required`, `sensitivity`, order    |
| `app.custom_list_column_options` | choice of a `single_choice` / `multi_choice` column               |
| `app.custom_list_rows`           | entry, with at most one link                                      |
| `app.custom_list_values`         | filled cell (per chosen option for `multi_choice`)                |

- **Link kinds** are four booleans on the list (`link_student`, `link_parent`, `link_staff`,
  `link_class`), not an array: the cross-tenant RLS coverage check rejects unapproved flexible
  (jsonb/array) columns.
- **Row links**: `link_kind` plus exactly the kind's own column, enforced by a CHECK. A student is
  `student_id`; a parent or a member of staff is `user_id` (the API checks the PARENT role or a
  school staff role); a class is `class_id`. Every link cascades on delete, as a record answer does.
- **Values are typed rows**, one per filled cell: `value_text` (short_text, long_text, phone,
  email), `value_number`, `value_date`, `value_bool` (yes_no) or `option_id` (a choice, one row per
  chosen option). A CHECK allows exactly one storage form.
- **Sensitive cells** store only `value_ciphertext`, `value_key_id` and `value_mask` (AES-256-GCM,
  ADR-019). The additional authenticated data is
  `school | custom_list_row | <row id> | <column id>`, so a cell can never be opened as a record
  answer or as another row's or column's cell. The records keyring seals them, and the key rotation
  job (`record-key-rotation.ts`) re-seals them with the record answers.
- **Field types**: every record field type except `document`. A list stores no files.
- Archiving a column hides it and keeps its values. Deleting a list cascades to its columns,
  choices, rows and values.

### Caps

| Cap                       | Value  |
| ------------------------- | ------ |
| Lists per school          | 50     |
| Columns per list (active) | 30     |
| Choices per column        | 100    |
| Rows per list             | 5,000  |
| Rows per school           | 20,000 |

The API enforces the caps under a per-school advisory lock
(`pg_advisory_xact_lock(hashtextextended('custom_lists:<school>', 0))`). It reads the school's
totals through `app.custom_list_usage()`, a SECURITY DEFINER function that returns two integers.
It counts past the audience scope, because otherwise a principal could pass the caps while
admin-only lists sit unseen.

At worst, 20,000 rows of 30 cells is 600,000 value rows per school, all served from the tenant's
`school_id` btree.

## Audiences and permissions

| Permission                 | Roles                   | Opens                                             |
| -------------------------- | ----------------------- | ------------------------------------------------- |
| `customList:manage`        | ORG_ADMIN, PRINCIPAL    | create, change and delete lists, columns, imports |
| `customList:use`           | every school staff role | read lists, add / edit / delete rows, export      |
| `customList:readSensitive` | ORG_ADMIN, PRINCIPAL    | the audited reveal of a sensitive cell            |

The school staff roles are ORG_ADMIN, PRINCIPAL, ATTENDANCE_OFFICER, FINANCE and INSTRUCTOR
(`SCHOOL_STAFF_ROLES`). SUPER_ADMIN holds all three. Parents, students and guests hold none.

Each list names its **audience**, which decides who may read and edit its rows:

| Audience     | Who                     |
| ------------ | ----------------------- |
| `admins`     | ORG_ADMIN               |
| `leadership` | ORG_ADMIN, PRINCIPAL    |
| `staff`      | every school staff role |

The audience is enforced twice:

- **In the database.** A RESTRICTIVE SELECT `role_scope_visibility` policy on `app.custom_lists`
  calls `app.can_read_custom_list(audience)`, a SECURITY DEFINER function over `app.user_roles`
  where SUPER_ADMIN counts as ORG_ADMIN. The other four tables admit a row exactly when its list is
  visible, and their EXISTS subquery runs under the list's own policy. A list outside the caller's
  audience, and every row and value in it, is therefore not found (404, never 403, so ids cannot be
  probed).
- **In the API.** A manager can give a list only an audience they belong to, so a principal cannot
  create an admins-only list and lose it.

## API

All routes are under the "Custom lists" tag. Writes need a web session; reads also serve the mobile
app.

| Route                                                                  | Gate                       |
| ---------------------------------------------------------------------- | -------------------------- |
| `GET /api/custom-lists`                                                | `customList:use`           |
| `POST /api/custom-lists`                                               | `customList:manage`        |
| `GET /api/custom-lists/linked/{subjectKind}/{subjectId}`               | `customList:use`           |
| `POST /api/custom-lists/imports/preview`                               | `customList:manage`        |
| `POST /api/custom-lists/imports/apply`                                 | `customList:manage`        |
| `GET /api/custom-lists/{listId}`                                       | `customList:use`           |
| `PATCH /api/custom-lists/{listId}`                                     | `customList:manage`        |
| `DELETE /api/custom-lists/{listId}`                                    | `customList:manage`        |
| `POST /api/custom-lists/{listId}/columns`                              | `customList:manage`        |
| `PATCH /api/custom-lists/{listId}/columns/{columnId}`                  | `customList:manage`        |
| `PUT /api/custom-lists/{listId}/column-order`                          | `customList:manage`        |
| `GET /api/custom-lists/{listId}/rows`                                  | `customList:use`           |
| `POST /api/custom-lists/{listId}/rows`                                 | `customList:use`           |
| `PATCH /api/custom-lists/{listId}/rows/{rowId}`                        | `customList:use`           |
| `DELETE /api/custom-lists/{listId}/rows/{rowId}`                       | `customList:use`           |
| `POST /api/custom-lists/{listId}/rows/{rowId}/cells/{columnId}/reveal` | `customList:readSensitive` |
| `GET /api/custom-lists/{listId}/export`                                | `customList:use`           |
| `GET /api/custom-lists/{listId}/link-candidates`                       | `customList:use`           |

The audience narrows every route.

**Link picker.** `GET …/link-candidates?kind=&q=` (at least two characters) offers up to 10
subjects of a kind the list allows: students, parents holding PARENT, members of staff holding a
staff role, or classes. They are matched by name or by the school's own key (admission number,
employee number, member code, class code) and read under the caller's RLS scope. Each comes with a
detail that tells namesakes apart. A person chooses; nothing is linked automatically, and the row
write checks the kind and role again.

**Rows.**

- `GET …/rows` takes:
  - `q`: free text over the non-sensitive cells (choices by their labels) and the linked
    subject's name;
  - `filter_column` and `filter_value`: text matches anywhere; numbers, dates, yes/no and choices
    match exactly;
  - `sort` (`created_at`, `updated_at`, `link`, or a column id) and `order`;
  - `link_kind`, `limit` (up to 200) and `offset`.

  A sensitive column cannot be filtered or sorted on (422).

- A linked subject's name is read under the caller's own RLS scope. Someone the caller cannot see
  comes back as a link with `name: null`, never resolved with wider rights.

**Export.**

- `GET …/export?lang=en|ar` returns UTF-8 CSV with a byte-order mark. Choices appear by their
  labels.
- Sensitive columns are always left out.
- A cell that a spreadsheet would read as a formula is prefixed with an apostrophe.
- Every export is audited (`action: export`).

**Reveal.**

- The reveal is audited before anything is opened: who, when, which list, row and column, never
  the value.
- The response is `Cache-Control: no-store`.

**Errors.**

| Code                        | Status | When                                                                      |
| --------------------------- | ------ | ------------------------------------------------------------------------- |
| `CUSTOM_LIST_NOT_FOUND`     | 404    | the list, column or row doesn't exist or is outside the caller's audience |
| `CUSTOM_LIST_INVALID`       | 422    | a list or column setting is not valid                                     |
| `CUSTOM_LIST_NAME_TAKEN`    | 409    | another list in the school has that name                                  |
| `CUSTOM_LIST_LIMIT_REACHED` | 409    | a cap would be passed                                                     |
| `CUSTOM_LIST_LINK_INVALID`  | 422    | the list does not allow that link, or the subject isn't found             |
| `CUSTOM_LIST_PREVIEW_STALE` | 409    | an import apply doesn't match its preview                                 |

Cell values reuse `RECORD_VALUE_INVALID`, `RECORD_FIELD_NOT_SENSITIVE` and
`RECORD_KEY_UNAVAILABLE`.

**Audit.** Every list, column and row write is audited. A sensitive cell's entry names the column
and never the value.

## Import: a sheet becomes a list

`POST /api/custom-lists/imports/preview` takes the CSV text with the new list's name, description
and audience, plus optional per-column choices: include, labels, type and sensitivity. The first
line names the columns.

**Types and sensitivity.** Each column's type is guessed from its own cells by `guessColumn` (from
`@studafy/student-import`, the same guess the student import makes). Imported values are never sent
anywhere else to be classified. A column whose header or values look like an ID number or medical
information starts sensitive, and staff decide. Past the 30-column cap, columns start left out.

**Links.** Rows may be linked by one column of the school's own keys, matched exactly: the whole
value, ignoring surrounding spaces and letter case, never partially.

| Key                | Links to                                                                           |
| ------------------ | ---------------------------------------------------------------------------------- |
| `member_id`        | a Studafy member code: `STU-` a student, `TCH-` a member of staff, `PAR-` a parent |
| `admission_number` | a student                                                                          |
| `employee_number`  | a member of staff                                                                  |
| `class_code`       | a class                                                                            |

Never by name, email, phone, government or national ID, or any record answer. A key that names
nothing is `NO_MATCH`. A key that names more than one subject is `AMBIGUOUS` and links neither.
With `skip_unmatched`, rows that did not link are left out.

**The preview** lists every row with its proposed link or the reason it has none. For every
included column it gives:

- the guessed type;
- a sample (masks for a sensitive column);
- the lines of invalid cells.

The new list's link kinds are the kinds the preview actually linked.

**The token.** The preview returns a `preview_token`, a SHA-256 over:

- the school and the caller;
- the CSV's hash;
- every choice;
- every row's outcome.

`POST …/imports/apply` takes the same body plus that token, and recomputes the plan. Anything that
changed answers 409 `CUSTOM_LIST_PREVIEW_STALE` and writes nothing.

**Apply.** It creates the list, its columns and its rows in one transaction:

- Cells that do not fit their column's type are left empty and counted.
- One audit row covers the whole import, recording what was written and never a cell.

## Search

The list names (`name_en` and `name_ar`, through the generated `search_tsv` column) appear in
global search as the `custom_lists` type. The section is gated on `customList:use`, and RLS narrows
it to the lists in the caller's audience.

Search never looks at a list's description or at any row value, sensitive or not.

## Privacy

`custom_list_rows` and `custom_list_values` are in `RECORD_DATA_TABLES`
(`apps/workers/src/queues/maintenance/records-dsr.ts`). The generic export and erasure walks skip
them for two reasons: a sensitive cell is ciphertext, and a cell has no link column to scope it by.
Instead:

- **Per-person export** includes every row linked to the person, as a student by `student_id` or
  as a parent or member of staff by `user_id`. It goes in `custom_list_rows.ndjson`, with:
  - the list's name;
  - the link;
  - each cell labelled by its column, with choices given with their labels;
  - sensitive cells opened, because the subject is entitled to their own data (GDPR art. 15).
- **Per-person erasure** deletes the person's linked rows outright, and their cells cascade. Rows
  linked to a class or to no one are about no person, and only a tenant closure reaches them.
- **Tenant closure export** includes every row of every list. The list, column and choice
  definitions go through the generic walk.
- **Tenant closure erasure** deletes every list, which cascades to columns, choices, rows and
  cells.

`retention-registry.ts` documents why `custom_list_rows` is reached through `student_id` and
`user_id` and never through `class_id`. No custom list table is a legal hold.

## Not done, and why

- **No document column type.** A list stores no files, which keeps storage, quota and content-class
  handling out of lists.
- **Type and sensitivity are fixed once a column exists.** Changing either would mean re-validating
  or re-sealing every value. Archive the column and add a new one instead.
- **No automatic retention sweep for sensitive list cells.** Record answers have one, keyed to when
  a student leaves. Sensitive list cells are deleted only by DSR erasure, by deleting the row,
  column or list, or by tenant closure.
- **The mobile app is read-only.** Writes need a web session, as for school records. INSTRUCTOR and
  ATTENDANCE_OFFICER are mobile-only roles: in the app they read the lists shared with them
  (Profile > Lists), with sensitive cells as masks and no reveal, and see a class's or student's
  linked rows from the class roster. They edit only from the web, if they also hold a web role.
  The attendance office screens show no Lists section, since they never show a single student or
  class.
