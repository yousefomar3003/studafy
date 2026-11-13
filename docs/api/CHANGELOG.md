# API changelog

Human-readable log of changes to [`apps/api/openapi.json`](../../apps/api/openapi.json), the
generated HTTP contract. Every pull request that changes that file adds an entry here under
**Unreleased** — CI enforces this (see
[`api-versioning-policy.md`](./api-versioning-policy.md)).

Format loosely follows [Keep a Changelog](https://keepachangelog.com/): group entries as `Added`,
`Changed`, `Removed`, or `Fixed` under a heading. Mark a `Changed`/`Removed` entry **(breaking)**
when it required the `version-bump` label.

## Unreleased

### Added

- Report card notes (000209): `GET`/`PUT /api/grading/report-card-settings` (`ReportCardSettings`,
  `UpdateReportCardSettingsBody`) choose which sections report cards and certificates show (subject
  comments, class teacher comment, principal comment, attendance, conduct; all default to shown)
  and the school's conduct ratings (`ReportCardConductRating`; the default four when none are
  saved). Reading needs `academicConfig:read`, changing `academicConfig:manage`.
  `GET /api/grading/sections/{sectionId}/report-notes?term_id=` returns a section's draft notes
  (`SectionReportNotes`); `PUT` on it (`SaveStudentNotesBody`) writes class teacher comments and
  conduct ratings (teachers of the section) and principal comments (school leadership), and
  `PUT /api/grading/sections/{sectionId}/subjects/{subjectId}/report-comments`
  (`SaveSubjectCommentsBody`) writes a subject teacher's comments. Writes need `grade:update` or
  `result:finalize`, and are refused once the period is finalized (`RESULTS_ALREADY_FINALIZED`).
  Finalizing freezes the notes and the period's attendance in days: `FinalizedStudentResult` gains
  `report` (`ReportCardNotes`, with `ReportCardConduct` and `ReportCardAttendance`; null for results
  finalized earlier), `FinalizedSubjectResult` gains `comment`, and `CertificateContent` gains
  optional `report` and `subjects[].comment` (absent on certificates issued earlier).

- Academic transcripts (000207): every finalized end-of-year result of a student on one immutable
  document with cumulative figures. `GET /api/grading/students/{studentId}/transcript-readiness`
  (`TranscriptReadiness`: state `ready` / `issued` / `needs_reissue` / `blocked`, the reasons, the
  covered years and `TranscriptReadinessCumulative`). `POST
/api/grading/students/{studentId}/transcripts` issues one (`AcademicTranscript`, 409
  `CERTIFICATE_BLOCKED` when a covered year is incomplete or there are none, 409
  `CONFLICT_STATE_MISMATCH` when one is already issued). `GET
/api/grading/students/{studentId}/transcripts` (`AcademicTranscriptList`) and `GET
/api/grading/transcripts/{transcriptId}` read them; `POST .../reissue` and `.../revoke` take a
  `CertificateReasonBody`. `TranscriptContent` holds the years oldest first (`TranscriptYear`,
  `TranscriptSubject` with `gpa_points` and `average_weight`) and `TranscriptCumulative`
  (`average_percentage` and `gpa` weighted by each subject's average weight across all years; `gpa`
  is null with `gpa_unavailable_reason` and `subjects_without_gpa_points` when a counted subject has
  no GPA points). `needs_reissue` and `stale_reasons` (`corrected`, `new_results`) flag a transcript
  whose results changed since. Readiness, issue, reissue and revoke need
  `academicCertificate:issue`; reading needs `grade:read` and is limited to school leadership, the
  student and a linked parent.

- Grading result formats and a third exam system (000206). `ExamStructure` gains `three_periods`
  (first, second and third period exams, a final exam, quizzes and homework) and `ExamWeights` and
  category kinds gain `third_period`. `GradeProgram` / `GradeProgramBody` gain `result_format`
  (`ResultFormat`: `percentage` (default), `out_of`, `gpa`) and `result_scale_max` (the maximum for
  `out_of`, up to 1000, or `gpa`, up to 10; null for `percentage`). Results gain
  `result_display` (`ResultDisplay`: `format`, `value`, `max`) on `ResultPreview` students and
  `FinalizedStudentResult`, and `CertificateContentOverall` gains optional `display`; certificates
  and results finalized earlier have none and stay percentages. A GPA averages the subjects'
  grade-band GPA points by subject weight; `value` is null when a counted subject has none, which
  the publish check reports as `GPA_POINTS_MISSING` (and `GPA_POINTS_ABOVE_MAX` for points above
  the maximum).

- Descriptive grading (000210), for subjects graded without numbers: `grading_method` takes
  `descriptive` (subject configs, `MarkSheetConfig`). A descriptive subject's assessments are
  skills; it never counts in the numeric average (`include_in_average` is forced false, retakes,
  weights and the final-exam rule are dropped). Each grade has a descriptor scale:
  `GradeProgram.descriptors` (`GradeDescriptor`: `position`, `label`, optional `points`,
  `not_achieved`), replaced through `GradeProgramBody.descriptors` (`GradeDescriptorBody`; a
  descriptor that marks use cannot be removed, 409). A grade gets a default scale (Excellent / Very
  good / Good / Needs improvement, or the Arabic equivalent) the first time a subject is made
  descriptive. `MarkSheet.descriptors` lists the scale; marks carry `descriptor_id`
  (`MarkSheetMark`, `GradingSaveMarksBodyEntry`, `GradingCorrectionBodyMark`), and a graded mark in
  a descriptive subject has a descriptor and no score. Results: `FinalizedSubjectResult` gains
  `is_descriptive`, `average_points` and `skills` (`DescriptiveSkillResult`),
  `ResultPreviewSubject` gains `is_descriptive`, fail reasons gain `DESCRIPTOR_NOT_ACHIEVED` (with
  `descriptor`), and `ReleasedMarkAttempt` gains `descriptor_label`. Certificates issued from now on
  mark such subjects `descriptive` with their `skills` (`CertificateContentSkill`). A subject with
  recorded marks cannot switch between marks and descriptors (409).
  Transcripts: `TranscriptSubject` gains optional `descriptive` and `skills` (`TranscriptSkill`), and
  descriptive subjects never count in the cumulative average or GPA. `TranscriptCumulative` gains
  `gpa_unavailable_reason` value `mixed_gpa_scales` (the covered years were shown as GPAs out of
  different maximums, e.g. 4 and 5), with `mixed_gpa_scales` (`TranscriptGpaScale`: each year and its
  maximum) and `gpa_scale_max` (the maximum all GPA years share, otherwise null).

- Paid storage add-on (000205): `GET /api/subscriptions/storage/offer` (`StorageAddOnOffer`: the
  school's usage and cap, its live add-on `StorageAddOnCurrent`, and each `StorageAddOnTier`
  (`storage_100gb`, `storage_1tb`) with its `StorageAddOnPrice`s in the school's currency, USD
  when none is set in it, plus `availableOnline`). `POST /api/subscriptions/storage/checkout`
  starts a hosted checkout. `POST /api/subscriptions/storage/change` moves a live add-on to another
  tier or interval, prorated: more storage is charged now and applied only once paid (402
  `STORAGE_ADDON_PAYMENT_FAILED` otherwise). `POST /api/subscriptions/storage/cancel` and
  `/cancel/reverse` stop or keep renewal (`StorageAddOnCancellation`). The offer needs
  `license:read`; the rest need `license:manage`. All are web only. New error codes are
  `STORAGE_ADDON_ALREADY_ACTIVE`, `STORAGE_ADDON_NOT_ACTIVE` and `STORAGE_ADDON_UNAVAILABLE` (409,
  or the school's provider can't sell it online), and `STORAGE_ADDON_PAYMENT_FAILED`. While an
  add-on is live, `BillingOverview.storage.capBytes` reports its cap.

- Parent directory: `GET /api/parents` (`ParentListQuery`: `search`, `cursor`, `limit`) and
  `GET /api/parents/{parentUserId}` return `ParentList` / `ParentSummary`: each parent's name,
  email, phone, status, Studafy ID (`member_code`) and children (`ParentChild`, with
  relationship and this year's `class_label`). Requires `user:read`, web only. A child's
  `admission_number` is null unless the caller holds `billing:read`, as on the student list.

- Contact phone for parents and teachers (000203): `UserWithRoles` / `UserListItem` gain `phone`
  (nullable). `CreateUserBody` and `CreateTeacherBody` take optional `phone`; `UpdateUserBody`
  takes `phone` (null removes it). A phone is 6 to 20 digits with `+ - ( ) .` and spaces; Arabic
  digits are read as 0-9. The student import's diff rows (`ImportDiffRow`, `ImportDiffParent`) gain
  `parent_phone`, and the import requires a phone for every parent a line names (new import fields
  `parent_phone`, `parent2_phone`). The Teachers import template requires one for every teacher.

- Exam window filters: `GET /api/academics/exams` (`ExamQuery`) takes optional `ends_after` and
  `starts_before` (ISO 8601 instants), so a "coming up" read gets only the exams in its window
  instead of the class's whole history. The mobile teacher home passes them.

- Login slips: `POST /api/users/member-setup-codes` (`IssueMemberSetupCodesRequest`) takes optional
  `include_pending` (also re-issue unused, unexpired codes: a reprint, which invalidates earlier
  slips) and `after` (page by member ID). `IssuedMemberSetupCodes` gains `last` (send it as `after`),
  and each item (`IssuedMemberSetupCode`, now a named schema) gains `class_label` (a student's grade
  and section this year) and `children` (a parent's linked children by name), for printing slips.

- Excel student import template: `GET /api/imports/students/template` takes
  `StudentImportTemplateQuery` (`format=csv|xlsx`, `lang=en|ar`). `format=xlsx` returns an Excel
  workbook with dropdowns of the school's grades and sections, its record fields as columns, and
  instructions ([student-import-mapping-guide.md](../modules/student-import-mapping-guide.md#excel-template-and-excel-upload)).
  The default is still the CSV template.

- Student import without email, with families, two parents and placement (migration 000198;
  [student-import-mapping-guide.md](../modules/student-import-mapping-guide.md#parents)):
  `StudentImportColumnMapping` gains `grade`, `section`, `family`, `parent2_name`, `parent2_email`
  and `parent2_relationship`, and `email` is no longer required. `ImportDiffRow` gains `parent2`
  (`ImportDiffParent`), `family`, `grade`, `section`, `placement` and `placement_conflict`;
  `parent` gains `kept` and `parent_conflict` gains `PARENT_EMAIL_IN_OTHER_FAMILY`. `ImportDiff`
  totals and `ImportSummary` gain `placed` and `placement_conflicts`. The CSV template now shows
  email-less students, a family and two parents.

- Realtime handshake tickets (QA-14, F-05; [protocol.md](../../apps/realtime/docs/protocol.md#handshake-ticket)),
  under the new "Realtime" tag: `GET /api/realtime/ticket` (`RealtimeTicket`). Bearer-authenticated;
  returns a single-use, 30-second ticket for the caller's own session, which the realtime gateway's
  `/ws?ticket=` handshake requires. The gateway no longer accepts the access token itself.
- Staging QA login (QA-02; [qa-staging-access.md](../runbooks/qa-staging-access.md)):
  `POST /api/auth/login/qa` (`QaLoginRequest`), answering with the existing login response. Signs in
  only the `qa` identities of schools flagged `is_qa_tenant` (migration 000183) with the shared
  `QA_LOGIN_PASSWORD`. Answers 404 when that password is unset, which is always the case in
  production.
- Custom lists (migration 000182; [custom-lists.md](../modules/custom-lists.md)), under the new
  "Custom lists" tag. School-defined tables with typed columns (`RecordColumnFieldType`: every record
  field type but `document`, and `RecordFieldSensitivity`) whose rows may link to a student, parent,
  member of staff or class:
  - Lists: `GET/POST /api/custom-lists` (`CustomListList`, `CustomListSummary`,
    `CreateCustomListBody`, `NewCustomListColumn`, `CustomListAudience`, `CustomListLinks`),
    `GET/PATCH/DELETE /api/custom-lists/{listId}` (`CustomListDetail`, `UpdateCustomListBody`).
  - Columns: `POST /api/custom-lists/{listId}/columns`, `PATCH …/columns/{columnId}`
    (`CustomListColumn`, `UpdateCustomListColumnBody`), `PUT …/column-order`
    (`ReorderCustomListColumnsBody`). Type and sensitivity cannot change once a column exists.
  - Rows: `GET/POST /api/custom-lists/{listId}/rows` (`CustomListRowPage`, `CustomListRow`,
    `CustomListRowLink`, `CustomListCell`, `CreateCustomListRowBody`, `CustomListRowLinkInput`,
    `CustomListCellInput`). The list query takes `q`, `filter_column`, `filter_value`, `sort`,
    `order`, `link_kind`, `limit` and `offset`. `PATCH/DELETE …/rows/{rowId}`
    (`UpdateCustomListRowBody`).
  - Sensitive cells: `POST …/rows/{rowId}/cells/{columnId}/reveal` (`RevealedCustomListCell`),
    audited.
  - CSV export: `GET …/export?lang=en|ar` (`text/csv`). Sensitive columns are always left out.
  - Link picker: `GET …/link-candidates?kind=&q=` (`CustomListLinkCandidates`,
    `CustomListLinkCandidate`). Up to 10 subjects of a kind the list allows, holding the matching
    role, that the caller can see, matched by name or school key, for a person to choose from.
  - A subject's Lists panel: `GET /api/custom-lists/linked/{subjectKind}/{subjectId}`
    (`CustomListLinkedRows`, `CustomListLinkedEntry`, `CustomListRef`, `CustomListLinkKind`).
  - A sheet as a new list: `POST /api/custom-lists/imports/preview` and `…/apply`
    (`CustomListImportBody`, `CustomListImportList`, `ApplyCustomListImportBody`,
    `CustomListImportColumnInput`,
    `CustomListImportKey`, `CustomListImportPreview`, `CustomListImportResult`). Rows link by
    school-issued key only (`member_id`, `admission_number`, `employee_number`, `class_code`), and
    only on an exact match. Nothing is written without the preview's token.
  - New permissions: `customList:manage` (ORG_ADMIN, PRINCIPAL), `customList:use` (every school
    staff role, narrowed by each list's audience: `admins`, `leadership` or `staff`) and
    `customList:readSensitive` (ORG_ADMIN, PRINCIPAL).
  - New error codes: `CUSTOM_LIST_NOT_FOUND`, `CUSTOM_LIST_INVALID`, `CUSTOM_LIST_NAME_TAKEN`,
    `CUSTOM_LIST_LIMIT_REACHED`, `CUSTOM_LIST_LINK_INVALID` and `CUSTOM_LIST_PREVIEW_STALE`.
  - Global search: new type `custom_lists` (`CustomListSearchHit`) in `SearchType`,
    `GlobalSearchResults` and `GlobalSearchTotals`. It matches list names only, never a row value.
- Staff and class records (migrations 000180, 000181;
  [student-records.md](../modules/student-records.md#staff-and-class-records)), under the new
  "Staff and class records" tag:
  - `RecordSubjectKind` gains `staff` and `class`, so `/api/record-templates/{subjectKind}…` and
    `GET /api/record-forms/{subjectKind}` serve them. A staff field must be `staff_only`; a class
    field `staff_only` or `teachers`, and never sensitive (422 `RECORD_FIELD_INVALID`). The form
    route now needs the subject's own update permission (`staffRecord:update`, `timetable:manage`).
  - `GET/PUT /api/staff/{staffUserId}/records`, `POST …/{fieldId}/reveal`,
    `PUT/PATCH/DELETE …/{fieldId}/document`, `GET …/{fieldId}/document/download`
    (`StaffRecordParam`, `StaffRecordFieldParam`), gated on the new permissions `staffRecord:read`,
    `staffRecord:update` and `staffRecord:readSensitive`. A PRINCIPAL's response leaves sensitive
    fields out.
  - `GET /api/me/staff-record` and `GET /api/me/staff-record/{fieldId}/document/download`
    (`SelfRecordFieldParam`): a member of staff's own non-sensitive fields; 403 for anyone holding
    no staff role.
  - `GET/PUT /api/classes/{classId}/records`, `PUT/PATCH/DELETE …/{fieldId}/document`,
    `GET …/{fieldId}/document/download` (`ClassRecordParam`, `ClassRecordFieldParam`): read with the
    new `classRecord:read`, edited with `timetable:manage`. No reveal: class fields are never
    sensitive.
  - `GET /api/records/missing/staff` (`RecordMissingStaffList`, `RecordMissingStaff`) and
    `GET /api/records/missing/classes` (`RecordMissingClassList`, `RecordMissingClass`).
  - `POST /api/record-imports/{subjectKind}/preview` and `…/apply` (`RecordImportSubjectKind`,
    `RecordImportParam`, `RecordImportColumnBody`, `ApplyRecordImportColumnBody`,
    `RecordImportNewField`, `RecordColumnFieldType`, `RecordImportPreview`,
    `RecordImportPreviewRow`, `RecordImportTotals`, `RecordImportApplyResult`): keep an unknown
    column of the users or classes CSV import as a record field, for the subjects the caller
    created in the last 24 hours (others are `skipped`).
  - Storage content classes `staffRecord.document`, `staffRecord.sensitiveDocument` and
    `classRecord.document`.

- Student import history, original files and unmapped columns (migration 000179;
  [student-import-mapping-guide.md](../modules/student-import-mapping-guide.md#import-history-and-unmapped-columns)):
  - `POST /api/imports/students/upload` gains optional `source_key` (`UploadImportQuery`): the temp
    key of the same file staged under the new content class `import.source` (`text/csv`, 25 MiB,
    `student:import`). The stored bytes must equal the body (400 `STORAGE_CHECKSUM_MISMATCH`); the
    file is kept as the import's original. `ImportRecord` gains `source_file` (`ImportSourceFile`:
    `file_name`, `size_bytes`, `uploaded_at`, `stored`, `expires_at`, `removed_at`,
    `removed_reason`).
  - `GET /api/imports/students` items are now `ImportListItem`: `ImportRecord` plus
    `uploaded_by_name`, `confirmed_by_name`, `unmapped_column_count`, `cells_available`.
  - `GET /api/imports/students/{importId}/source` (one-minute signed URL, audited;
    `ImportSourceDownload`) and `DELETE /api/imports/students/{importId}/source` (204). 404
    `IMPORT_SOURCE_NOT_FOUND` once the file is gone.
  - `GET /api/imports/students/{importId}/columns` (`UnmappedColumns`, `UnmappedColumn`): unmapped
    columns with a suggested field type, suggested options, `suggested_sensitive`,
    `sensitive_reason` and what each was applied to.
  - `POST /api/imports/students/{importId}/columns/preview` (`ImportColumnTarget` →
    `ImportColumnPreview`, `ImportColumnPreviewRow`) and `POST …/columns/apply`
    (`ApplyImportColumnBody` → `ImportColumnApplyResult`): write a completed import's unmapped
    column to an existing or new (`ImportColumnNewField`) student or parent record field, for the
    people the import itself wrote. Both need `studentRecord:update` too; a new field needs
    `recordTemplate:manage`. New error codes: `IMPORT_COLUMN_NOT_FOUND`,
    `IMPORT_CELLS_UNAVAILABLE`, `IMPORT_COLUMN_PREVIEW_STALE`, `IMPORT_RECORD_DRAFT_PENDING`.
  - `GET`/`PUT /api/imports/students/settings` (`ImportSettings`, `UpdateImportSettingsBody`):
    how long originals and leftover cells are kept, 1-180 days (default 180).
  - `GET /api/platform/import-signals/unmapped-headers` (`platform:read`, `UnmappedHeaderSignal`):
    normalized unmapped header text with school and import counts, shown once 3 schools share it.
  - `ContentClass` (storage uploads) gains `import.source`.

- `GET /api/privacy/dsr` (`privacy:manageDsr`): the school's per-person export and erasure
  requests, newest first, optionally for one `subject_user_id` (`DataSubjectRequestListQuery`,
  `SchoolDataSubjectRequestList`, `SchoolDataSubjectRequest` = `DataSubjectRequest` plus
  `subject_display_name`). A closure's whole-school request is not listed; a download link is
  still signed per request by `GET /api/privacy/dsr/{requestId}`.
- Finance corrections through the refund maker-checker queue (migration 000177):
  - `POST /api/finance/invoices/{invoiceId}/cancellation` and
    `POST /api/finance/payments/{paymentId}/reversal` (maker, `billing:update`; body
    `CorrectionRequestBody`: `reason_code`, required `reason_notes`; params `CorrectionInvoiceParam`,
    `CorrectionPaymentParam`). Each creates a pending request; the existing
    `POST /api/finance/refunds/{refundId}/approve` (`billing:refund`, a different user) cancels the
    Sales Invoice or Payment Entry in ERPNext and completes it. 409 `INVOICE_NOT_CANCELLABLE` (not
    submitted, or a payment or credit note is against it), `PAYMENT_NOT_REVERSIBLE` (not confirmed,
    or no invoice), `ADJUSTMENT_ALREADY_REQUESTED` (one open or completed request per invoice or
    payment).
  - `Refund` gains `kind` (named enum `RefundKind`: `credit_note`, `invoice_cancellation`,
    `payment_reversal`); `RefundQuery` gains `kind`. `ReasonCode` gains `write_off`: a credit note
    that clears what is still owed, refused above the outstanding balance with 400
    `WRITE_OFF_EXCEEDS_OUTSTANDING`.
  - `PaymentStatus` gains `reversed`.
- `GET /api/finance/reports/collections-by-method` (`report:viewFinancial`): confirmed payments per
  day, currency and method between `from_date` and `to_date` (at most 400 days), with range totals
  (`CollectionsByMethodQuery`, `CollectionsByMethodReport`, `CollectionsByMethodRow`,
  `CollectionsByMethodTotal`). Read from Studafy's payment records, not ERPNext.
- Sales tax (VAT) settings (migration 000178): `GET /api/finance/tax-settings` (`billing:read`),
  `PUT /api/finance/tax-settings` (`organization:manageSettings`) (`TaxSettings`,
  `UpdateTaxSettingsBody`). Off by default; when on, the billing worker adds an ERPNext "On Net
  Total" tax row to every invoice it generates and zero-rates exempt fee categories.
  `InvoiceDetail` gains `net_total`, `taxes` (`InvoiceTax[]`) and `tax_registration_number`; the
  payment receipt prints the registration number.
- `GET /api/finance/students/{studentId}` (`billing:read`): one student's identity, enrolment status
  and family for finance's per-student account page (`FinanceStudentIdentity`,
  `FinanceStudentIdParam`), withdrawn students included.
- `GET /api/finance/payments`: `payment_mode`, `date_from`, `date_to` and `search` (payment or
  invoice number, student name or admission number); `PaymentList` gains `totals`
  (`PaymentTotal[]`: confirmed money matching the filters, every page, per currency).
- `GET /api/finance/invoices`: `issued_from`, `issued_to`, `due_from`, `due_to` (inclusive; a
  backwards range is a 400).

- Global search covers twenty record types (`GET /api/search`, migration 000171):
  - Named query enum `SearchType` (`students`, `users`, `invoices`, `materials`, `classes`,
    `sections`, `subjects`, `grade_levels`, `academic_years`, `terms`, `rooms`, `families`,
    `announcements`, `events`, `incidents`, `evaluations`, `fee_structures`, `scholarships`,
    `expenses`, `notifications`); `SearchQuery` gains `types` (array of `SearchType`, repeated or
    comma-separated; omitted = all) and `offset` (0–1000, default 0).
  - `GlobalSearchResult` gains `types` (the requested `SearchType[]`, echoed) and `totals`
    (`GlobalSearchTotals`, one integer per type: total matches the caller can see, 0 when not
    requested or not permitted). `results` is now the named `GlobalSearchResults` and always carries
    all twenty arrays.
  - New hit schemas: `ClassSearchHit`, `SectionSearchHit`, `SubjectSearchHit`,
    `GradeLevelSearchHit`, `AcademicYearSearchHit`, `TermSearchHit`, `RoomSearchHit`,
    `FamilySearchHit`, `AnnouncementSearchHit`, `EventSearchHit`, `IncidentSearchHit`,
    `EvaluationSearchHit`, `FeeStructureSearchHit`, `ScholarshipSearchHit`, `ExpenseSearchHit`,
    `NotificationSearchHit`. Each section is gated by the permission its own list endpoint requires
    (incidents: `principalDashboard:view` and `disciplineIncident:read`; notifications: the
    caller's own inbox) and narrowed by the same row scope.

- School-defined student and parent records (see
  [`docs/modules/student-records.md`](../modules/student-records.md)), tag "Student and parent
  records":
  - Template editor (`recordTemplate:manage`): `GET /api/record-templates/{subjectKind}`,
    `POST …/fields`, `PATCH …/fields/{fieldId}` (edit or `archived`), `PUT …/field-order`,
    `POST …/publish` (`RecordTemplate`, `RecordTemplateField`, `CreateRecordFieldBody`,
    `UpdateRecordFieldBody`, `ReorderRecordFieldsBody`, `RecordTemplateVersion`). 409
    `RECORD_FIELD_LOCKED` for a published field's type or a sensitive field made standard; 409
    `RECORD_NOTHING_TO_PUBLISH`.
  - `GET /api/record-forms/{subjectKind}` (`studentRecord:update`): the published form (`RecordForm`,
    `RecordFieldDefinition`).
  - Records for `/api/students/{studentId}` and `/api/parents/{parentUserId}`: `GET`/`PUT …/records`
    (`SubjectRecords`, `RecordEntry`, `UpdateRecordsBody`, `RecordAnswerInput`, `RecordValue`);
    `POST …/records/{fieldId}/reveal` (`studentRecord:readSensitive`, audited, `RevealedRecordValue`);
    `PUT`/`PATCH`/`DELETE …/records/{fieldId}/document` and `GET …/document/download`
    (`AttachRecordDocumentBody`, `UpdateRecordDocumentBody`, `RecordDocument`,
    `RecordDocumentDownload`). Sensitive values are always `value: null` with a `mask` outside the
    reveal call. Record responses carry `Cache-Control: no-store`.
  - Missing information (`studentRecord:read`): `GET /api/records/missing/students`,
    `…/parents`, `…/summary` (`RecordMissingQuery` with the named `RecordMissingIssue` filter,
    echoed as `issue`; `RecordMissingStudentList`, `RecordMissingParentList`, `RecordMissingSummary`).
  - `POST /api/students` and `POST /api/users` (PARENT only): optional `records`
    (`RecordAnswerInput[]`), written in the same transaction; needs `studentRecord:update`.
  - Storage content classes `record.document` and `record.sensitiveDocument` for
    `POST /api/storage/uploads/request-upload`.
  - Error codes `RECORD_TEMPLATE_NOT_PUBLISHED`, `RECORD_NOTHING_TO_PUBLISH`,
    `RECORD_FIELD_NOT_FOUND`, `RECORD_FIELD_INVALID`, `RECORD_FIELD_LOCKED`,
    `RECORD_FIELD_NOT_DOCUMENT`, `RECORD_FIELD_NOT_SENSITIVE`, `RECORD_VALUE_INVALID`,
    `RECORD_SUBJECT_NOT_FOUND`, `RECORD_DOCUMENT_NOT_FOUND`, `RECORD_KEY_UNAVAILABLE`.
  - Student import: `StudentImportColumnMapping.records` (template field id -> source column),
    `ImportDiffRow.records` (`ImportDiffRecordValue`, sensitive values masked),
    `ImportDiffRow.parent_conflict`, `parent_group_line`, `parent_email`, `parent_name`,
    `ImportDiff.totals.parent_conflicts`, and `ImportSummary.parent_conflicts` / `record_answers`.

- Linking parents and children (see
  [`docs/modules/finance-module-guide.md`](../modules/finance-module-guide.md#how-parents-and-children-get-linked)):
  - `POST /api/users`: optional `children` (`CreateUserChild`: `student_id`, `relationship`) links a
    new PARENT to students in the same transaction. It is refused with 400 for any other role or a
    student listed twice, with 404 for a student outside the school (nothing is created), and with 403
    without `parent:link`. The response now documents 404.
  - `GET /api/finance/unlinked/students`, `GET /api/finance/unlinked/parents` and
    `GET /api/finance/unlinked/summary` (`billing:read`): enrolled students with no guardian and
    PARENT accounts with no children, searchable and offset-paginated (`FinanceUnlinkedQuery`;
    `FinanceUnlinkedStudentList`, `FinanceUnlinkedParentList`, `FinanceUnlinkedSummary`).
  - `POST /api/finance/invoices/batches/preflight` (`billing:read`, writes nothing): resolves a
    batch's targets (`InvoiceBatchPreflightBody`, same rules as `CreateInvoiceBatchBody`) and
    reports `total_count`, `unlinked_count` and the first 100 `unlinked_students`
    (`InvoiceBatchPreflight`, `InvoiceBatchUnlinkedStudent`).

- Paid features and school licensing (see
  [`docs/billing/feature-licensing.md`](../billing/feature-licensing.md)):
  - `GET /api/me/features`: the caller's paid features with their verdicts.
  - School licenses and seats: `/api/school/license` (overview, seats, eligible people, change
    requests) and the super admin's `/api/platform/schools/{schoolId}/licenses` console.
  - License billing: the school's quotes, invoices, receipts and payments under
    `/api/school/license/{quotes,invoices,payments,receipts}`; the super admin's price settings,
    bank details, calculator (`POST /api/platform/licenses/quote`), cross-school invoices, pending
    receipts and finance totals under `/api/platform/licenses/*`, and quotes, invoices, payments and
    receipts under `/api/platform/schools/{schoolId}/license-*`.
  - AI routes answer `429 FEATURE_LIMIT_REACHED` when a tier's monthly unit limit is used up.
  - The super admin's license console: `GET /api/platform/features`,
    `PATCH /api/platform/features/{featureKey}`, `GET`/`POST /api/platform/tiers`,
    `PUT /api/platform/tiers/{planId}`, `GET /api/platform/licenses` (across schools, with
    expiring / nearly-full / unpaid filters), `GET /api/platform/licenses/change-requests`,
    `GET /api/platform/licenses/usage` and `GET /api/platform/schools/{schoolId}/license-console`.
  - The school's side: `GET /api/school/license/people` (everyone in an audience with their seat
    and personal subscription end date) and `GET /api/school/license/tiers` (what each tier gives,
    without prices).
- Finance family accounts (`/api/finance/families`, payments, profile, reminders, statements),
  payment receipts (`GET /api/finance/payments/{paymentId}/receipt`), reminders and the sibling
  discount (`/api/finance/sibling-discount`).
- Year-scoped academic grading under `/api/grading/*`: scales, programs, subject configs, teacher
  assignments, mark sheets and marks, results preview and finalization, certificates.
- Public account deletion without the app or a session (ST-302; see
  [`docs/modules/account-deletion.md`](../modules/account-deletion.md#web-deletion-flow-no-sign-in)).
  Both unauthenticated (`security: []`), CSRF-exempt and `auth-strict` rate-limited:
  - `POST /api/account/deletion-requests` (`AccountDeletionRequest`: `email`, `captcha_token`)
    emails a one-hour, single-use deletion link if the address has accounts. Always `202` with the
    same `AccountDeletionRequestAccepted` body, so it does not disclose whether an address is
    registered. `400 CAPTCHA_INVALID` on a failed Turnstile check.
  - `POST /api/account/deletion-requests/confirm` (`AccountDeletionConfirm`: `token`) deletes every
    active account under that address through the same pipeline as `POST /api/account/deletion`,
    answering `202` with `AccountDeletionConfirmed`: `accounts[]` (`school_name`, `request_id`,
    `completes_by`) and `retained_records`. `400 VERIFICATION_TOKEN_INVALID` for an unknown,
    expired or used token.
- `POST /api/account/deletion` — self-service account deletion (ST-301; see
  [`docs/modules/account-deletion.md`](../modules/account-deletion.md)). Bearer-authenticated
  only; the caller is the subject. Signs out every session, detaches the account from the school,
  stops AI add-on billing and files an erasure request, answering `202` with an `AccountDeletion`
  body: `request_id`, `status`, `requested_at`, `completes_by`, `ai_subscriptions_canceled` and
  `retained_records` (`RetainedRecord`: `category`, `description`, `legal_basis`). New `Account`
  tag and error code `APPLE_TOKEN_REVOCATION_FAILED`.
- `POST /api/auth/login/review`: email/password login for the App Store / Play reviewer demo
  tenant only (ST-303; see [`docs/runbooks/app-review-access.md`](../runbooks/app-review-access.md)).
  Public, rate-limited `auth-strict`, and answers 404 unless `REVIEW_LOGIN_PASSWORD` is configured.
  Returns the same token pair as `POST /api/auth/login/oauth`, whose response schema it reuses.
- Error code `REVIEW_TENANT_BILLING_DISABLED` (403), returned by school checkout and online fee
  payment for the reviewer demo tenant.
- Student CSV column mapping and staging (ST-299; see
  [`docs/modules/student-import-mapping-guide.md`](../modules/student-import-mapping-guide.md)):
  - `PUT /api/imports/students/{importId}/mapping` re-maps an unconfirmed import's staged rows,
    with an optional `save_as`.
  - `GET /api/imports/students/{importId}/diff` is the dry-run diff (create / update / unchanged /
    conflict) against live data.
  - `GET|POST /api/imports/students/mappings` and
    `PATCH|DELETE /api/imports/students/mappings/{mappingId}` manage per-school saved column
    mappings.
  - `POST /api/imports/students/upload` takes an optional `mapping_id` query parameter and accepts
    any CSV layout (header row detection, `,`/`;`/tab delimiters).
  - `ImportRecord` gains `confirmed_by`, `header_line`, `source_headers` and `column_mapping`.
  - `ImportSummary` gains optional `students_updated` and `conflicts`.
  - Error codes `IMPORT_MAPPING_NOT_FOUND`, `IMPORT_MAPPING_NAME_EXISTS` and
    `IMPORT_MAPPING_INVALID`.

- `POST /api/subscriptions/webhook/tap` — Tap Payments charge webhooks. Authenticated by the
  `hashstring` HMAC (keyed with the Tap secret key), not a bearer token; the charge is re-read from
  Tap before use. Normalized to the same billing events as the Stripe webhook. ST-298.
- `POST /api/finance/online-payments` — start a hosted online payment for an invoice's full
  outstanding balance, at the payment provider for the school's region (Tap Payments in AE, BH,
  EG, JO, KW, OM, QA, SA; Stripe elsewhere). Open to a parent linked to the student and to staff
  with `billing:update`. ST-298.
- `GET /api/finance/online-payments/{paymentId}` — an online fee payment's status; visible to the
  payer and to staff with `billing:read`. ST-298.
- `501` and `502` problem responses. A `502` on the checkout routes and
  `GET /api/subscriptions/current/invoices` means the payment provider failed; a `501` means the
  school's provider has no equivalent for the operation. ST-298.

- `GET /meta/mobile-versions` — the forced-update floor endpoint from ST-257
  (`GET /api/mobile/config`), also served under this canonical name. Same handler, same schema,
  same unauthenticated posture; `/api/mobile/config` stays mounted unchanged because the released
  native app already calls it. ST-283.
- `POST /api/auth/sessions/revoke-others` — self-service "sign out other sessions": revokes every
  live token family the caller holds except the one behind the presented refresh token (the cookie
  for a web caller, `refresh_token` in the body otherwise), and denylists the access tokens they
  minted. Answers 400 rather than guessing when the current session cannot be identified, since a
  wrong guess would end the very session the request came in on. ST-280.
- `POST /api/announcements` — compose a school/role/class-targeted announcement, published
  immediately or, when `scheduled_at` is in the future, by the workers' publish sweep.
  `mandatory: true` sends as the un-optoutable `ADMIN_ANNOUNCEMENT` type; `mandatory: false` as
  `ANNOUNCEMENT`, which recipients may disable. Callers holding `notification:send` but not
  `notification:manage` may compose only a non-mandatory notice to a class they teach. ST-194 / ST-238.
- `GET /api/announcements` — keyset-paginated school announcement history, newest first, with each
  row's reach snapshot (`recipient_count` / `notified_count`). `notification:manage`. ST-194.
- `POST /api/privacy/dsr` — file a GDPR export or erasure request for one user
  (`PRIVACY_DSR_MANAGE`). ST-268.
- `GET /api/privacy/dsr/{requestId}` — read a data subject request's status and, once a completed
  export, a short-lived download URL. ST-268.
- `POST /api/privacy/me/dsr` — self-service: file a GDPR export or erasure request for the
  caller's own account. Bearer-authenticated only, no permission gate — the subject is always the
  caller, never a body parameter. Backs the mobile app store's account-deletion requirement (Apple
  5.1.1(v) / Google Play Data Safety); see `apps/mobile/store/review-checklist.md`.
- `GET /api/privacy/me/dsr` — the caller's own data subject request history, most recent first.
- `GET /api/ai/health` — unauthenticated black-box check reporting whether the `AI_LLM_ENABLED`
  kill switch is on. Backs the public status page's `ai` component
  (`infra/terraform/modules/monitoring`, since removed with the AWS stack); deliberately does not call the Anthropic provider. ST-264.
- `GET /api/search` — role-scoped Postgres full-text search across students, users, invoices, and
  materials, grouped per type. A section is populated only when the caller holds that type's own
  read permission (`STUDENT_READ` / `USER_READ` / `BILLING_READ` / `MATERIAL_READ`); row-level
  security within a populated section matches that type's own list endpoint. Every call is
  recorded as a `read` audit entry against `global_search`. ST-278.
- Pictures on questions in a `questions` assignment: `QuestionInput.image` takes either
  `upload_key` (a picture staged through `POST /api/storage/uploads/request-upload` with the new
  `assignment.question_image` content class, confirmed by the save) or `keep_from_question_id`
  (keep a picture already on the set). `AssignmentQuestion.image` returns it with a short-lived
  `download_url`, and is absent for a question with no picture. A question may now be a picture
  with an empty `prompt`.

### Changed

- Deleting a file now frees its storage. `DELETE /api/academics/materials/{materialId}` (with the
  material's thumbnail and preview), `DELETE /api/academics/assignments/{assignmentId}` (its
  attachments and question pictures, when it is deleted rather than archived),
  `DELETE /api/academics/assignments/{assignmentId}/attachments/{attachmentId}`,
  `DELETE /api/academics/submissions/{submissionId}/attachments/{attachmentId}` and a question save
  that drops a picture all remove the stored object once the change has committed and release its
  bytes from the school's storage quota. A file another row still points at is kept (000204
  `app.referenced_storage_keys`). An expense receipt that is replaced is a finance record and is
  never removed: `PATCH /api/finance/expenses/{expenseId}` and
  `POST /api/finance/expenses/{expenseId}/attachments` record the old and new
  `attachment_storage_key` in the audit log instead. No request or response shape changed.

- `GET /api/privacy/dsr/{requestId}` (`DataSubjectRequest`): a completed export's `download_url` now
  points at the export's ZIP archive (`dsr-exports/<school>/<request>/export.zip`: a README, the data
  as JSON with one file per table, `manifest.json`, and copies of the person's files) instead of a
  bare `manifest.json`, and works for an hour instead of 15 minutes. A key outside the request's own
  export prefix is never signed. `download_url` and `download_url_expires_at` gained descriptions.
  Same fields and types; not breaking.

- **(breaking)** `POST /api/inquiries` (`SubmitInquiry`): `phone` is now required. It must look like
  a phone number: digits with `+`, `-`, `(`, `)`, `.` and spaces, 6 to 20 digits in all; anything
  else answers 400. The sales team calls schools back, and an email address alone was too easy to
  miss. The only client, the website's "Talk to us" form, now asks for it. Migration: send a phone
  number.

- The student import's column calls take `ImportSubjectKind` (`student` | `parent`) for
  `subject_kind` in `ImportColumnTarget`, `ApplyImportColumnBody`, `ImportColumnPreview` and
  `UnmappedColumn.applied`, rather than `RecordSubjectKind`, which now also lists `staff` and
  `class`. Same accepted values as before.

- `GET /api/search` matching: the phrase is normalized (case, Arabic harakat/tatweel, alef forms,
  ى → ي, ة → ه), split into letter/digit words and matched as all of them with the last one as a
  prefix (`oma` → Omar, `inv-00` → INV-0012), replacing `websearch_to_tsquery`; names fall back to
  trigram matching (word similarity ≥ 0.5) when nothing matches exactly (for students, classes
  and subjects: nothing in the whole school, so a name outside the caller's scope gives an empty
  section rather than look-alikes). Existing hit shapes are
  unchanged; `rank` is the trigram similarity for a typo match. The audit entry also records
  `types`, `offset` and per-type `totals`.

- Student import no longer matches parents by email (see
  [`docs/modules/finance-module-guide.md`](../modules/finance-module-guide.md#how-parents-and-children-get-linked))
  **(breaking)**: `ImportDiffRow.parent` is now `create | sibling | conflict` (`existing` is gone);
  a `parent_email` that belongs to an existing account is `parent: "conflict"` with
  `parent_conflict: "PARENT_ACCOUNT_EXISTS"`, and the student is still imported with no link.
  `ImportDiffRow.link` is now `create` or null (`update` / `unchanged` are gone).
  `ImportDiff.totals.links_updated` is replaced by `parent_conflicts`.
  `PARENT_EMAIL_BELONGS_TO_STUDENT` now means only a new student in the same file; a live
  student's email is `PARENT_ACCOUNT_EXISTS`.

- `POST /api/students`: `guardians` now require `parent:link` on top of `student:create` (403
  otherwise). Each guardian is linked through the same checked, audited path as
  `POST /api/students/{studentId}/guardians`, so an unknown parent is now 404 (it was 400) and a
  parent listed twice is 400. The response now documents 404. Every role that can create students
  already holds `parent:link`.
- `PUT /api/academics/assignments/{assignmentId}/questions` takes at most 20 questions (was 100)
  and 2-4 options per multiple-choice question (was 2-6).
- Handing in a `questions` assignment now marks it and releases the grade at once: the returned
  submission is `status: graded`, `grade_status: published`, with `score` set and
  `graded_by_user_id` null. A released quiz cannot be resubmitted until the teacher returns it.

- `POST /api/school/license/change-requests` also takes `studentPlanId` / `teacherPlanId` /
  `parentPlanId` (a tier wanted per audience), and every `LicenseChangeRequest` now carries
  `studentTier` / `teacherTier` / `parentTier`.
- `GET /api/me/features` adds `schoolName` and, per feature, `schoolSeat`, `schoolOffers` and
  `renewalStop`.
- `GET /api/subscriptions/ai/offer` adds `schoolSeat` and `schoolOffers` per student;
  `POST /api/subscriptions/ai/checkout` answers `409 AI_SUBSCRIPTION_COVERED_BY_SCHOOL` for a
  student holding a school-license seat.
- `POST /api/account/deletion` now also emails the account a confirmation (`account.deleted`
  outbox event), and its audit entry records `source: "account_settings"` (`"web_request"` for the
  public flow above). No change to the HTTP contract. ST-302.
- `POST /api/subscriptions/checkout` is now web-origin only, like every other subscription purchase
  route: a `mobile` or `api` session gets `403 CHANNEL_NOT_AUTHORIZED` (already a documented
  response). The app stores forbid a native app from starting an outside purchase of a digital
  good; no client called it from mobile. ST-304 (see
  [`apps/mobile/docs/store_payment_routing.md`](../../apps/mobile/docs/store_payment_routing.md)).

### Fixed

- **Security:** academic year, term, class enrolment and exam writes were guarded only by
  sign-in, and row-level security fences them to the school, not to a role, so any signed-in
  member of a school (a student or parent included) could create, change or delete years, terms and
  exams, enrol, withdraw or transfer students, or roll the year over (closing it and archiving
  every enrolment). `POST /api/academics/years`, `PATCH`/`DELETE /api/academics/years/{yearId}`,
  `POST /api/academics/years/{yearId}/rollover`, `POST /api/academics/years/{yearId}/terms`,
  `PATCH`/`DELETE /api/academics/terms/{termId}`,
  `POST /api/academics/classes/{classId}/enrollments`,
  `DELETE /api/academics/classes/{classId}/enrollments/{studentId}`,
  `POST /api/academics/classes/{classId}/enrollments/transfer`, `POST /api/academics/exams` and
  `PATCH`/`DELETE /api/academics/exams/{examId}` now require `timetable:manage` (ORG_ADMIN,
  PRINCIPAL), like the subjects, classes and sections they belong with; anyone else gets 403.
  Reads are unchanged.
- `GET /api/finance/invoices`, `GET /api/finance/invoices/{invoiceId}` and
  `GET /api/finance/invoices/batches/{batchId}/items` returned nothing (404 for the detail) to a
  FINANCE caller: they joined the student's name under the caller's own row-level security, which
  hides every student from a role without `student:read`. They now read through the finance
  identity transaction, like the other finance lists.
- `GET /api/finance/invoices`, `GET /api/finance/invoices/batches` and
  `GET /api/finance/invoices/batches/{batchId}/items` never returned a `next_cursor`, so no list got
  past its first page.

- `POST /api/students` with `guardians` wrote no `parent_child_links` audit row; it now writes one
  per link, like the Guardians tab.
- `GET /api/teachers/me` answered `403 CHANNEL_NOT_AUTHORIZED` to mobile sessions (and required
  `TEACHER_READ`), because the web-only `/api/teachers/{teacherId}` guards matched `me` as an id.
  The id is now constrained to a UUID; `/me` is reachable from every channel as documented. ST-303.
- `GET /api/imports/students` never returned a `next_cursor`: it fetched one row past the page and
  then compared the row count against that same inflated limit. It now pages. ST-299.
