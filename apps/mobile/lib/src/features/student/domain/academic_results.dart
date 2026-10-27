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

  bool get isExempt => status == 'exempt';
  bool get isIncomplete => status == 'incomplete';
}

/// The overall line of a finalized result or certificate.
class OverallResult {
  const OverallResult({
    required this.averagePercentage,
    required this.totalObtained,
    required this.totalMax,
    required this.gradeLabel,
    required this.subjectsFailed,
    required this.academicStatus,
  });

  factory OverallResult.fromJson(Map<String, Object?> json) => OverallResult(
    averagePercentage: _num(json['average_percentage']),
    totalObtained: _num(json['total_obtained']),
    totalMax: _num(json['total_max']),
    gradeLabel: json['grade_label'] as String?,
    subjectsFailed: (json['subjects_failed'] as num?)?.toInt() ?? 0,
    academicStatus: AcademicStatus.fromWire(json['academic_status']),
  );

  final double? averagePercentage;
  final double? totalObtained;
  final double? totalMax;
  final String? gradeLabel;
  final int subjectsFailed;
  final AcademicStatus academicStatus;
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
