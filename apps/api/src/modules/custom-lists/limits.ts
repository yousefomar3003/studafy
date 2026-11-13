/**
 * The custom lists vocabulary and caps (docs/modules/custom-lists.md). The enums mirror
 * db/migrations/000182_create_custom_lists.sql.
 *
 * The caps keep one school's lists to a size a single Postgres instance serves from one tenant's
 * btree without thought: 20,000 rows of at most 30 cells is 600,000 value rows at the very worst,
 * about what one year of a large school's attendance writes. A list that outgrows 5,000 rows is
 * usually data that deserves a real Studafy section rather than a bigger spreadsheet.
 */

export const CUSTOM_LIST_AUDIENCES = ["admins", "leadership", "staff"] as const;
export const CUSTOM_LIST_LINK_KINDS = ["student", "parent", "staff", "class"] as const;
export const CUSTOM_LIST_IMPORT_KEYS = [
  "member_id",
  "admission_number",
  "employee_number",
  "class_code",
] as const;

export const MAX_LISTS_PER_SCHOOL = 50;
export const MAX_COLUMNS_PER_LIST = 30;
export const MAX_OPTIONS_PER_COLUMN = 100;
export const MAX_ROWS_PER_LIST = 5_000;
export const MAX_ROWS_PER_SCHOOL = 20_000;
/** A CSV of 5,000 rows of 30 cells of ~30 characters, with room to spare. */
export const MAX_IMPORT_CSV_BYTES = 5_000_000;
/** Rows of one list shown in a subject's Lists panel. */
export const MAX_LINKED_ROWS_PER_LIST = 50;
/** People or classes offered by the link picker for one search. */
export const MAX_LINK_CANDIDATES = 10;
