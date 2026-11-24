/// Domain model for academic transcripts (`/api/grading/students/{studentId}/transcripts`,
/// `/api/grading/transcripts/{transcriptId}`; OpenAPI schema `AcademicTranscript`).
///
/// A transcript is every finalized end-of-year result of a student on one document, with the
/// cumulative average and GPA. Hand-written like `academic_results.dart` (whose subject, overall
/// and status types it reuses): the stored `content` is rendered exactly as issued.
library;

import '../../../core/localization/localized_name.dart';
import 'academic_results.dart';
import 'graduation_requirements.dart';

/// One academic year on a transcript.
class TranscriptYear {
  const TranscriptYear({
    required this.academicYearName,
    required this.gradeLevelName,
    required this.sectionName,
    required this.subjects,
    required this.overall,
    this.academicYearNameAr,
    this.gradeLevelNameAr,
    this.sectionNameAr,
  });

  factory TranscriptYear.fromJson(Map<String, Object?> json) => TranscriptYear(
    academicYearName: _map(json['academic_year'])['name'] as String? ?? '',
    gradeLevelName: json['grade_level_name'] as String? ?? '',
    sectionName: json['section_name'] as String? ?? '',
    academicYearNameAr: arabicNameOf(_map(json['academic_year'])['name_ar']),
    gradeLevelNameAr: arabicNameOf(json['grade_level_name_ar']),
    sectionNameAr: arabicNameOf(json['section_name_ar']),
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

  /// The Arabic names at issue (000264); null when there were none.
  final String? academicYearNameAr;
  final String? gradeLevelNameAr;
  final String? sectionNameAr;
}

/// Why a transcript has no cumulative GPA (or no cumulative figures at all).
enum TranscriptGpaUnavailableReason {
  missingGpaPoints,
  incomplete,
  noSubjects,

  /// The years were graded on different GPA scales (out of 4 one year, 5 another).
  mixedGpaScales;

  static TranscriptGpaUnavailableReason? fromWire(Object? value) =>
      switch (value) {
        'missing_gpa_points' => missingGpaPoints,
        'incomplete' => incomplete,
        'no_subjects' => noSubjects,
        'mixed_gpa_scales' => mixedGpaScales,
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
    this.mixedGpaScales = const [],
    this.weightedGpa,
    this.creditsAttempted,
    this.creditsEarned,
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
        mixedGpaScales: [
          for (final scale in _list(json['mixed_gpa_scales']))
            (
              year: scale['academic_year_name'] as String? ?? '',
              max: _num(scale['max']) ?? 0,
            ),
        ],
        // Absent on transcripts issued before credits existed.
        weightedGpa: _num(json['weighted_gpa']),
        creditsAttempted: _num(json['credits_attempted']),
        creditsEarned: _num(json['credits_earned']),
      );

  final double? averagePercentage;
  final double? gpa;
  final TranscriptGpaUnavailableReason? gpaUnavailableReason;
  final List<String> subjectsWithoutGpaPoints;
  final int yearsCovered;

  /// When [gpaUnavailableReason] is [TranscriptGpaUnavailableReason.mixedGpaScales]: each GPA
  /// year and its maximum.
  final List<({String year, double max})> mixedGpaScales;

  /// The cumulative GPA with Honors/AP/HL boosts; null when there is none.
  final double? weightedGpa;

  /// Credits across every covered year; null when no subject carries credits.
  final double? creditsAttempted;
  final double? creditsEarned;
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
    this.graduationRequirements = const [],
    this.language,
    this.schoolNameAr,
    this.studentNameAr,
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
      graduationRequirements: [
        for (final row in _list(json['graduation_requirements']))
          TranscriptGraduationRequirement.fromJson(row),
      ],
      // Arabic + English documents (000264): absent on transcripts issued before.
      language: DocumentLanguage.fromWire(json['language']),
      schoolNameAr: arabicNameOf(_map(json['school'])['name_ar']),
      studentNameAr: studentArabicName(student),
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

  /// Whether the student met each graduation requirement set applying to them, as it stood at
  /// issue. Empty when none applied, and on transcripts issued before they existed.
  final List<TranscriptGraduationRequirement> graduationRequirements;

  /// The language it was issued in; null follows the app's language.
  final DocumentLanguage? language;
  final String? schoolNameAr;
  final String? studentNameAr;
}

/// One graduation requirement set's outcome on a transcript.
class TranscriptGraduationRequirement {
  const TranscriptGraduationRequirement({
    required this.name,
    required this.status,
    required this.rulesMet,
    required this.rulesTotal,
  });

  factory TranscriptGraduationRequirement.fromJson(Map<String, Object?> json) =>
      TranscriptGraduationRequirement(
        name: json['name'] as String? ?? '',
        status: GraduationStatus.fromWire(json['status']),
        rulesMet: (json['rules_met'] as num?)?.toInt() ?? 0,
        rulesTotal: (json['rules_total'] as num?)?.toInt() ?? 0,
      );

  final String name;
  final GraduationStatus status;
  final int rulesMet;
  final int rulesTotal;
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
