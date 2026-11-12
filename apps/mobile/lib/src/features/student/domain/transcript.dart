/// Domain model for academic transcripts (`/api/grading/students/{studentId}/transcripts`,
/// `/api/grading/transcripts/{transcriptId}`; OpenAPI schema `AcademicTranscript`).
///
/// A transcript is every finalized end-of-year result of a student on one document, with the
/// cumulative average and GPA. Hand-written like `academic_results.dart` (whose subject, overall
/// and status types it reuses): the stored `content` is rendered exactly as issued.
library;

import 'academic_results.dart';

/// One academic year on a transcript.
class TranscriptYear {
  const TranscriptYear({
    required this.academicYearName,
    required this.gradeLevelName,
    required this.sectionName,
    required this.subjects,
    required this.overall,
  });

  factory TranscriptYear.fromJson(Map<String, Object?> json) => TranscriptYear(
    academicYearName: _map(json['academic_year'])['name'] as String? ?? '',
    gradeLevelName: json['grade_level_name'] as String? ?? '',
    sectionName: json['section_name'] as String? ?? '',
    subjects: [
      for (final subject in _list(json['subjects']))
        SubjectResult.fromJson(subject),
    ],
    overall: OverallResult.fromJson(_map(json['overall'])),
  );

  final String academicYearName;
  final String gradeLevelName;
  final String sectionName;
  final List<SubjectResult> subjects;
  final OverallResult overall;
}

/// Why a transcript has no cumulative GPA (or no cumulative figures at all).
enum TranscriptGpaUnavailableReason {
  missingGpaPoints,
  incomplete,
  noSubjects;

  static TranscriptGpaUnavailableReason? fromWire(Object? value) =>
      switch (value) {
        'missing_gpa_points' => missingGpaPoints,
        'incomplete' => incomplete,
        'no_subjects' => noSubjects,
        _ => null,
      };
}

/// The cumulative figures across every covered year, as the API computed them.
class TranscriptCumulative {
  const TranscriptCumulative({
    required this.averagePercentage,
    required this.gpa,
    required this.gpaUnavailableReason,
    required this.subjectsWithoutGpaPoints,
    required this.yearsCovered,
  });

  factory TranscriptCumulative.fromJson(Map<String, Object?> json) =>
      TranscriptCumulative(
        averagePercentage: _num(json['average_percentage']),
        gpa: _num(json['gpa']),
        gpaUnavailableReason: TranscriptGpaUnavailableReason.fromWire(
          json['gpa_unavailable_reason'],
        ),
        subjectsWithoutGpaPoints: [
          for (final name
              in (json['subjects_without_gpa_points'] as List<Object?>?) ??
                  const <Object?>[])
            '$name',
        ],
        yearsCovered: (json['years_covered'] as num?)?.toInt() ?? 0,
      );

  final double? averagePercentage;
  final double? gpa;
  final TranscriptGpaUnavailableReason? gpaUnavailableReason;
  final List<String> subjectsWithoutGpaPoints;
  final int yearsCovered;
}

/// A transcript exactly as issued (`content`).
class TranscriptContent {
  const TranscriptContent({
    required this.serialNumber,
    required this.issuedAt,
    required this.schoolName,
    required this.studentName,
    required this.admissionNumber,
    required this.years,
    required this.cumulative,
    required this.issuedByName,
    required this.reissueOfSerial,
    required this.reissueReason,
  });

  factory TranscriptContent.fromJson(Map<String, Object?> json) {
    final student = _map(json['student']);
    final reissue = json['reissue'];
    return TranscriptContent(
      serialNumber: json['serial_number'] as String? ?? '',
      issuedAt: DateTime.tryParse(json['issued_at'] as String? ?? ''),
      schoolName: _map(json['school'])['name'] as String? ?? '',
      studentName:
          '${student['first_name'] as String? ?? ''} '
                  '${student['last_name'] as String? ?? ''}'
              .trim(),
      admissionNumber: student['admission_number'] as String? ?? '',
      years: [
        for (final year in _list(json['years'])) TranscriptYear.fromJson(year),
      ],
      cumulative: TranscriptCumulative.fromJson(_map(json['cumulative'])),
      issuedByName: _map(json['issued_by'])['name'] as String?,
      reissueOfSerial: reissue is Map
          ? reissue['supersedes_serial'] as String?
          : null,
      reissueReason: reissue is Map ? reissue['reason'] as String? : null,
    );
  }

  final String serialNumber;
  final DateTime? issuedAt;
  final String schoolName;
  final String studentName;
  final String admissionNumber;

  /// Oldest year first.
  final List<TranscriptYear> years;
  final TranscriptCumulative cumulative;
  final String? issuedByName;
  final String? reissueOfSerial;
  final String? reissueReason;
}

class AcademicTranscript {
  const AcademicTranscript({
    required this.id,
    required this.serialNumber,
    required this.status,
    required this.issuedAt,
    required this.revokedAt,
    required this.revokeReason,
    required this.needsReissue,
    required this.content,
  });

  factory AcademicTranscript.fromJson(Map<String, Object?> json) =>
      AcademicTranscript(
        id: json['id']! as String,
        serialNumber: json['serial_number'] as String? ?? '',
        status: CertificateStatus.fromWire(json['status']),
        issuedAt: DateTime.tryParse(json['issued_at'] as String? ?? ''),
        revokedAt: DateTime.tryParse(json['revoked_at'] as String? ?? ''),
        revokeReason: json['revoke_reason'] as String?,
        needsReissue: json['needs_reissue'] as bool? ?? false,
        content: TranscriptContent.fromJson(_map(json['content'])),
      );

  final String id;
  final String serialNumber;

  /// Issued, superseded (replaced by a reissue) or revoked — the certificate lifecycle.
  final CertificateStatus status;
  final DateTime? issuedAt;
  final DateTime? revokedAt;
  final String? revokeReason;

  /// Results changed (a correction, or a newer year) after this was issued.
  final bool needsReissue;
  final TranscriptContent content;
}

List<Map<String, Object?>> _list(Object? value) => [
  for (final item in (value as List<Object?>?) ?? const <Object?>[])
    Map<String, Object?>.from(item! as Map),
];

Map<String, Object?> _map(Object? value) =>
    value is Map ? Map<String, Object?>.from(value) : const {};

double? _num(Object? value) => value is num ? value.toDouble() : null;
