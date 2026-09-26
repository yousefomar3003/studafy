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
  ParentRelationship,
  StudentImportField,
  StudentImportFieldDefinition,
  StudentImportTarget,
  StudentStatus,
} from "./fields";

export {
  normalizeHeader,
  readCsvSource,
  stageRows,
  suggestColumnMapping,
  validateColumnMapping,
} from "./mapping";
export type { ColumnMapping, CsvSource, SourceRow, StagedRow, StagedRows } from "./mapping";

export { normalizeAdmissionNumber, normalizeEmail, toStudentImportRecord } from "./record";
export type { StudentImportIssue, StudentImportRecord, StudentImportValues } from "./record";

export { planStudentImport, UPDATABLE_STUDENT_FIELDS } from "./plan";
export type {
  FieldChange,
  PlannedRow,
  StagedRecord,
  StudentImportAction,
  StudentImportConflict,
  StudentImportPlan,
  StudentImportPlanTotals,
  UpdatableStudentField,
} from "./plan";
