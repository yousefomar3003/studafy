/// Domain model for a student's finalized academic results and certificates
/// (`/api/grading/students/{studentId}/results`, `.../certificates`, `/api/grading/certificates/{id}`;
/// OpenAPI tag `Results`).
///
/// Hand-written for the same reason as `features/teacher/domain/mark_sheet.dart`: the generated
/// names for these nested shapes are positional and shift as the spec grows. JSON shapes follow
/// the API's `grading/schemas.ts` (`FinalizedStudentResult`, `AcademicCertificate`,
/// `CertificateContent`).
library;

/// A student's year-end standing, as finalized.
enum AcademicStatus {
  promoted,
  supplementary,
  retained,
  incomplete;

  static AcademicStatus fromWire(Object? value) => switch (value) {
    'promoted' => promoted,
    'supplementary' => supplementary,
    'retained' => retained,
    _ => incomplete,
  };
}

/// One subject's finalized result.
class SubjectResult {
  const SubjectResult({
    required this.subjectId,
    required this.code,
    required this.name,
    required this.status,
    required this.percentage,
    required this.marksObtained,
    required this.maxMarks,
    required this.gradeLabel,
    required this.passed,
    required this.terms,
    this.comment,
  });

  factory SubjectResult.fromJson(Map<String, Object?> json) => SubjectResult(
    subjectId: json['subject_id'] as String? ?? '',
    code: json['subject_code'] as String? ?? json['code'] as String? ?? '',
    name: json['subject_name'] as String? ?? json['name'] as String? ?? '',
    status: json['exempt'] == true
        ? 'exempt'
        : json['status'] as String? ?? 'complete',
    percentage: _num(json['percentage']),
    marksObtained: _num(json['marks_obtained']),
    maxMarks: _num(json['max_marks']) ?? 0,
    gradeLabel: json['grade_label'] as String?,
    passed: json['passed'] as bool?,
    terms: [
      for (final term in _list(json['terms']))
        (
          termId: term['term_id'] as String?,
          termName: term['term_name'] as String?,
          percentage: _num(term['percentage']),
        ),
    ],
    comment: _text(json['comment']),
  );

  final String subjectId;
  final String code;
  final String name;

  /// `complete`, `incomplete` or `exempt`.
  final String status;
  final double? percentage;
  final double? marksObtained;
  final double maxMarks;
  final String? gradeLabel;
  final bool? passed;

  /// Per-term percentages (`termName` is set only on certificate content).
  final List<({String? termId, String? termName, double? percentage})> terms;

  /// The subject teacher's report card comment; null when there is none (and on results and
  /// certificates from before report card notes).
  final String? comment;

  bool get isExempt => status == 'exempt';
  bool get isIncomplete => status == 'incomplete';
}

/// The overall line of a finalized result or certificate.
/// How a grade shows its final result.
enum ResultFormat {
  percentage,
  outOf,
  gpa;

  static ResultFormat? fromWire(Object? value) => switch (value) {
    'percentage' => ResultFormat.percentage,
    'out_of' => ResultFormat.outOf,
    'gpa' => ResultFormat.gpa,
    _ => null,
  };
}

/// The final result in the grade's chosen format: 16.5 out of 20, or a GPA of 3.4 out of 4.
class ResultDisplay {
  const ResultDisplay({
    required this.format,
    required this.value,
    required this.max,
  });

  /// Null for anything that isn't a display object, or a format this app doesn't know yet.
  static ResultDisplay? fromJson(Object? json) {
    if (json is! Map) return null;
    final format = ResultFormat.fromWire(json['format']);
    final max = _num(json['max']);
    if (format == null || max == null) return null;
    return ResultDisplay(format: format, value: _num(json['value']), max: max);
  }

  final ResultFormat format;

  /// Null when it can't be worked out (a GPA with a subject that has no GPA points).
  final double? value;
  final double max;
}

class OverallResult {
  const OverallResult({
    required this.averagePercentage,
    required this.totalObtained,
    required this.totalMax,
    required this.gradeLabel,
    required this.subjectsFailed,
    required this.academicStatus,
    this.display,
  });

  /// Reads a finalized result (`result_display`) or a certificate's overall block (`display`).
  /// Results and certificates from before result formats have neither: they are percentages.
  factory OverallResult.fromJson(Map<String, Object?> json) => OverallResult(
    averagePercentage: _num(json['average_percentage']),
    totalObtained: _num(json['total_obtained']),
    totalMax: _num(json['total_max']),
    gradeLabel: json['grade_label'] as String?,
    subjectsFailed: (json['subjects_failed'] as num?)?.toInt() ?? 0,
    academicStatus: AcademicStatus.fromWire(json['academic_status']),
    display: ResultDisplay.fromJson(json['result_display'] ?? json['display']),
  );

  final double? averagePercentage;
  final double? totalObtained;
  final double? totalMax;
  final String? gradeLabel;
  final int subjectsFailed;
  final AcademicStatus academicStatus;
  final ResultDisplay? display;
}

/// Days of recorded attendance in the report's period. Late days are counted within present days;
/// present + absent + excused = recorded.
class ReportAttendance {
  const ReportAttendance({
    required this.from,
    required this.to,
    required this.daysRecorded,
    required this.daysPresent,
    required this.daysAbsent,
    required this.daysLate,
    required this.daysExcused,
  });

  factory ReportAttendance.fromJson(Map<String, Object?> json) =>
      ReportAttendance(
        from: DateTime.tryParse(json['from'] as String? ?? ''),
        to: DateTime.tryParse(json['to'] as String? ?? ''),
        daysRecorded: (json['days_recorded'] as num?)?.toInt() ?? 0,
        daysPresent: (json['days_present'] as num?)?.toInt() ?? 0,
        daysAbsent: (json['days_absent'] as num?)?.toInt() ?? 0,
        daysLate: (json['days_late'] as num?)?.toInt() ?? 0,
        daysExcused: (json['days_excused'] as num?)?.toInt() ?? 0,
      );

  final DateTime? from;
  final DateTime? to;
  final int daysRecorded;
  final int daysPresent;
  final int daysAbsent;
  final int daysLate;
  final int daysExcused;
}

/// Report card notes as finalized: comments, conduct and attendance. Any part the school does not
/// show is null.
class ReportNotes {
  const ReportNotes({
    required this.teacherComment,
    required this.principalComment,
    required this.conductLabel,
    required this.conductLabelAr,
    required this.attendance,
  });

  factory ReportNotes.fromJson(Map<String, Object?> json) {
    final conduct = json['conduct'];
    final attendance = json['attendance'];
    return ReportNotes(
      teacherComment: _text(json['teacher_comment']),
      principalComment: _text(json['principal_comment']),
      conductLabel: conduct is Map ? _text(conduct['label']) : null,
      conductLabelAr: conduct is Map ? _text(conduct['label_ar']) : null,
      attendance: attendance is Map
          ? ReportAttendance.fromJson(Map<String, Object?>.from(attendance))
          : null,
    );
  }

  /// Null when the payload has no `report` (results and certificates from before report card
  /// notes).
  static ReportNotes? maybe(Object? value) => value is Map
      ? ReportNotes.fromJson(Map<String, Object?>.from(value))
      : null;

  final String? teacherComment;
  final String? principalComment;
  final String? conductLabel;
  final String? conductLabelAr;
  final ReportAttendance? attendance;

  /// The conduct rating in the reader's language: Arabic when given and the app is in Arabic.
  String? conductFor(String languageCode) =>
      languageCode == 'ar' && conductLabelAr != null
      ? conductLabelAr
      : conductLabel;

  bool get isEmpty =>
      teacherComment == null &&
      principalComment == null &&
      conductLabel == null &&
      attendance == null;
}

/// One finalization (a term report or the annual result) for the student, current version only.
class FinalizedResult {
  const FinalizedResult({
    required this.finalizationId,
    required this.academicYearId,
    required this.academicYearName,
    required this.sectionName,
    required this.gradeLevelName,
    required this.termId,
    required this.termName,
    required this.version,
    required this.finalizedAt,
    required this.overall,
    required this.subjects,
    this.report,
  });

  factory FinalizedResult.fromJson(Map<String, Object?> json) {
    final result = _map(json['result']);
    return FinalizedResult(
      finalizationId: json['finalization_id']! as String,
      academicYearId: json['academic_year_id']! as String,
      academicYearName: json['academic_year_name'] as String? ?? '',
      sectionName: json['section_name'] as String? ?? '',
      gradeLevelName: json['grade_level_name'] as String? ?? '',
      termId: json['term_id'] as String?,
      termName: json['term_name'] as String?,
      version: (json['version'] as num?)?.toInt() ?? 1,
      finalizedAt: DateTime.tryParse(json['finalized_at'] as String? ?? ''),
      overall: OverallResult.fromJson(result),
      subjects: [
        for (final subject in _list(result['subjects']))
          SubjectResult.fromJson(subject),
      ],
      report: ReportNotes.maybe(result['report']),
    );
  }

  final String finalizationId;
  final String academicYearId;
  final String academicYearName;
  final String sectionName;
  final String gradeLevelName;

  /// Null for the annual result.
  final String? termId;
  final String? termName;

  /// Above 1 when the results were corrected after the first finalization.
  final int version;
  final DateTime? finalizedAt;
  final OverallResult overall;
  final List<SubjectResult> subjects;

  /// Comments, conduct and attendance; null for results finalized before report card notes.
  final ReportNotes? report;

  bool get isAnnual => termId == null;
}

/// Results grouped by academic year, newest finalization first within each year, and years in
/// the order their newest finalization arrived (most recent year first).
List<({String yearName, List<FinalizedResult> results})> groupResultsByYear(
  List<FinalizedResult> results,
) {
  final sorted = [...results]
    ..sort((a, b) {
      final aTime = a.finalizedAt ?? DateTime.fromMillisecondsSinceEpoch(0);
      final bTime = b.finalizedAt ?? DateTime.fromMillisecondsSinceEpoch(0);
      return bTime.compareTo(aTime);
    });
  final byYear = <String, List<FinalizedResult>>{};
  final names = <String, String>{};
  for (final result in sorted) {
    byYear.putIfAbsent(result.academicYearId, () => []).add(result);
    names[result.academicYearId] = result.academicYearName;
  }
  return [
    for (final entry in byYear.entries)
      (yearName: names[entry.key]!, results: entry.value),
  ];
}

enum CertificateStatus {
  issued,
  superseded,
  revoked;

  static CertificateStatus fromWire(Object? value) => switch (value) {
    'superseded' => superseded,
    'revoked' => revoked,
    _ => issued,
  };

  /// Superseded and revoked documents are kept on record but are no longer valid.
  bool get isValid => this == issued;
}

/// The certificate or report card exactly as issued (`content`). Rendered as stored — never
/// recomputed from current results.
class CertificateContent {
  const CertificateContent({
    required this.kind,
    required this.serialNumber,
    required this.issuedAt,
    required this.schoolName,
    required this.academicYearName,
    required this.termName,
    required this.studentName,
    required this.admissionNumber,
    required this.gradeLevelName,
    required this.sectionName,
    required this.subjects,
    required this.overall,
    required this.finalizationVersion,
    required this.finalizedAt,
    required this.issuedByName,
    required this.reissueOfSerial,
    required this.reissueReason,
    this.report,
  });

  factory CertificateContent.fromJson(Map<String, Object?> json) {
    final student = _map(json['student']);
    final term = json['term'];
    final reissue = json['reissue'];
    final finalization = _map(json['finalization']);
    return CertificateContent(
      kind: json['kind'] as String? ?? 'annual_certificate',
      serialNumber: json['serial_number'] as String? ?? '',
      issuedAt: DateTime.tryParse(json['issued_at'] as String? ?? ''),
      schoolName: _map(json['school'])['name'] as String? ?? '',
      academicYearName: _map(json['academic_year'])['name'] as String? ?? '',
      termName: term is Map ? term['name'] as String? : null,
      studentName:
          '${student['first_name'] as String? ?? ''} '
                  '${student['last_name'] as String? ?? ''}'
              .trim(),
      admissionNumber: student['admission_number'] as String? ?? '',
      gradeLevelName: json['grade_level_name'] as String? ?? '',
      sectionName: json['section_name'] as String? ?? '',
      subjects: [
        for (final subject in _list(json['subjects']))
          SubjectResult.fromJson(subject),
      ],
      overall: OverallResult.fromJson(_map(json['overall'])),
      finalizationVersion: (finalization['version'] as num?)?.toInt(),
      finalizedAt: DateTime.tryParse(
        finalization['finalized_at'] as String? ?? '',
      ),
      issuedByName: _map(json['issued_by'])['name'] as String?,
      reissueOfSerial: reissue is Map
          ? reissue['supersedes_serial'] as String?
          : null,
      reissueReason: reissue is Map ? reissue['reason'] as String? : null,
      report: ReportNotes.maybe(json['report']),
    );
  }

  final String kind;
  final String serialNumber;
  final DateTime? issuedAt;
  final String schoolName;
  final String academicYearName;

  /// Set on a term report card; null on an annual certificate.
  final String? termName;
  final String studentName;
  final String admissionNumber;
  final String gradeLevelName;
  final String sectionName;
  final List<SubjectResult> subjects;
  final OverallResult overall;
  final int? finalizationVersion;
  final DateTime? finalizedAt;
  final String? issuedByName;
  final String? reissueOfSerial;
  final String? reissueReason;

  /// Comments, conduct and attendance as printed; null on certificates issued before them.
  final ReportNotes? report;
}

class AcademicCertificate {
  const AcademicCertificate({
    required this.id,
    required this.kind,
    required this.serialNumber,
    required this.status,
    required this.academicYearId,
    required this.issuedAt,
    required this.revokedAt,
    required this.revokeReason,
    required this.reissueReason,
    required this.needsReissue,
    required this.content,
  });

  factory AcademicCertificate.fromJson(Map<String, Object?> json) =>
      AcademicCertificate(
        id: json['id']! as String,
        kind: json['kind'] as String? ?? 'annual_certificate',
        serialNumber: json['serial_number'] as String? ?? '',
        status: CertificateStatus.fromWire(json['status']),
        academicYearId: json['academic_year_id'] as String? ?? '',
        issuedAt: DateTime.tryParse(json['issued_at'] as String? ?? ''),
        revokedAt: DateTime.tryParse(json['revoked_at'] as String? ?? ''),
        revokeReason: json['revoke_reason'] as String?,
        reissueReason: json['reissue_reason'] as String?,
        needsReissue: json['needs_reissue'] as bool? ?? false,
        content: CertificateContent.fromJson(_map(json['content'])),
      );

  final String id;

  /// `annual_certificate` or `term_report`.
  final String kind;
  final String serialNumber;
  final CertificateStatus status;
  final String academicYearId;
  final DateTime? issuedAt;
  final DateTime? revokedAt;
  final String? revokeReason;
  final String? reissueReason;

  /// Results were corrected after this was issued; a reissue is due.
  final bool needsReissue;
  final CertificateContent content;

  bool get isTermReport => kind == 'term_report';
}

List<Map<String, Object?>> _list(Object? value) => [
  for (final item in (value as List<Object?>?) ?? const <Object?>[])
    Map<String, Object?>.from(item! as Map),
];

Map<String, Object?> _map(Object? value) =>
    value is Map ? Map<String, Object?>.from(value) : const {};

double? _num(Object? value) => value is num ? value.toDouble() : null;

/// A non-blank string, or null.
String? _text(Object? value) =>
    value is String && value.trim().isNotEmpty ? value : null;
