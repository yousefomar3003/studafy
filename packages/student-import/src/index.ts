export { parseCsv, detectDelimiter } from "./csv";
export type { CsvDelimiter, CsvRecord } from "./csv";

export {
  PARENT_RELATIONSHIPS,
  REQUIRED_STUDENT_IMPORT_FIELDS,
  STUDENT_IMPORT_FIELD_DEFINITIONS,
  STUDENT_IMPORT_FIELDS,
  STUDENT_STATUSES,
} from "./fields";
export type {
  ImportRecordField,
  ParentRelationship,
  StudentImportField,
  StudentImportFieldDefinition,
  StudentImportTarget,
  StudentStatus,
} from "./fields";

export {
  normalizeHeader,
  readCsvSource,
  recordIssueField,
  stageRows,
  suggestColumnMapping,
  validateColumnMapping,
} from "./mapping";
export type { ColumnMapping, CsvSource, SourceRow, StagedRow, StagedRows } from "./mapping";

export { guessColumn, unmappedColumns } from "./unmapped";
export type { ColumnGuess, ImportableFieldType, UnmappedColumn } from "./unmapped";

export {
  normalizeAdmissionNumber,
  normalizeEmail,
  PARENT_SLOTS,
  toStudentImportRecord,
  withRecordDefaults,
} from "./record";
export type {
  ParentSlot,
  StudentImportIssue,
  StudentImportRecord,
  StudentImportValues,
} from "./record";

export { nameKey, planStudentImport, UPDATABLE_STUDENT_FIELDS } from "./plan";
export type {
  FieldChange,
  PlannedParent,
  PlannedParentOutcome,
  PlannedPlacement,
  PlannedRow,
  StagedRecord,
  StudentImportAction,
  StudentImportConflict,
  StudentImportParentConflict,
  StudentImportPlacementConflict,
  StudentImportPlan,
  StudentImportPlanTotals,
  UpdatableStudentField,
} from "./plan";
