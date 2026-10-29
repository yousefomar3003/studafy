/**
 * The browser-safe half of @studafy/records: the field vocabulary, value validation and masking,
 * without the keyring or AES-GCM (node:crypto). For code that also runs in apps/web, such as
 * @studafy/student-import's column mapping.
 */
export {
  DEFAULT_SENSITIVE_RETENTION_MONTHS,
  MAX_RETENTION_MONTHS,
  MIN_RETENTION_MONTHS,
  RECORD_DOCUMENT_STATUSES,
  RECORD_FIELD_SENSITIVITIES,
  RECORD_FIELD_TYPES,
  RECORD_FIELD_VISIBILITIES,
  RECORD_SUBJECT_KINDS,
  isFieldVisibleTo,
  labelSuggestsSensitive,
  visibilitiesFor,
} from "./fields";
export type {
  RecordAudience,
  RecordDocumentStatus,
  RecordFieldOption,
  RecordFieldSensitivity,
  RecordFieldType,
  RecordFieldVisibility,
  RecordSubjectKind,
} from "./fields";
export { LONG_TEXT_MAX, RECORD_VALUE_ERRORS, SHORT_TEXT_MAX, normalizeRecordValue } from "./values";
export type {
  NormalizedRecordValue,
  RecordValue,
  RecordValueError,
  RecordValueField,
} from "./values";
export { FULL_MASK, maskRecordValue } from "./mask";
