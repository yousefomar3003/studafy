/// Domain model for a student's finalized academic results and certificates
/// (`/api/grading/students/{studentId}/results`, `.../certificates`, `/api/grading/certificates/{id}`;
/// OpenAPI tag `Results`).
///
/// Hand-written for the same reason as `features/teacher/domain/mark_sheet.dart`: the generated
/// names for these nested shapes are positional and shift as the spec grows. JSON shapes follow
/// the API's `grading/schemas.ts` (`FinalizedStudentResult`, `AcademicCertificate`,
/// `CertificateContent`).
library;

import '../../../core/localization/localized_name.dart';

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
    this.isDescriptive = false,
    this.skills = const [],
    this.credits,
    this.courseLevel,
    this.weightedGpaPoints,
    this.nameAr,
    this.outcomes = const [],
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
    // `is_descriptive` on finalized results, `descriptive` on certificate content.
    isDescriptive:
        json['is_descriptive'] == true || json['descriptive'] == true,
    skills: [
      for (final skill in _list(json['skills']))
        (
          name: skill['name'] as String? ?? '',
          groupName: skill['category_name'] as String? ?? '',
          termId: skill['term_id'] as String?,
          termName: skill['term_name'] as String?,
          descriptor: skill['descriptor_label'] as String?,
        ),
    ],
    // Absent on results, certificates and transcripts from servers or documents before credits.
    credits: _num(json['credits']),
    courseLevel: _text(json['course_level']),
    weightedGpaPoints: _num(json['weighted_gpa_points']),
    // `subject_name_ar` on results, `name_ar` on documents; absent before 000263.
    nameAr: arabicNameOf(json['subject_name_ar'] ?? json['name_ar']),
    // Learning outcome achievement as finalized; absent before 000267 and when the school does
    // not show it.
    outcomes: [
      for (final outcome in _list(json['outcomes']))
        if (_text(outcome['code']) case final code?)
          (
            code: code,
            text: outcome['text'] as String? ?? '',
            textAr: _text(outcome['text_ar']),
            level: _int(outcome['level']),
            label: _text(outcome['label']),
            labelAr: _text(outcome['label_ar']),
          ),
    ],
  );

  final String subjectId;
  final String code;
  final String name;

  /// The subject's Arabic name, when the school has one (see `localized_name.dart`).
  final String? nameAr;

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

  /// Graded with descriptors (kindergarten, early primary): no marks or percentage; [gradeLabel]
  /// is the subject's descriptor when its scale has points, and [skills] carry the detail.
  final bool isDescriptive;

  /// A descriptive subject's skills and the descriptor each was given (`termName` is set only on
  /// certificate content).
  final List<
    ({
      String name,
      String groupName,
      String? termId,
      String? termName,
      String? descriptor,
    })
  >
  skills;

  /// Credit hours (American and IB schools); null when the subject has none.
  final double? credits;

  /// Course level shown beside the subject ("Honors", "AP", "HL"); null for none.
  final String? courseLevel;

  /// GPA points with the course level's boost; null when the subject has no boost.
  final double? weightedGpaPoints;

  /// Learning outcome achievement on the report card, in catalogue order; empty when the school
  /// does not show it (and on results and documents from before it existed).
  final List<
    ({
      String code,
      String text,
      String? textAr,
      int? level,
      String? label,
      String? labelAr,
    })
  >
  outcomes;

  bool get isExempt => status == 'exempt';
  bool get isIncomplete => status == 'incomplete';
}

/// The overall line of a finalized result or certificate.
/// How a grade shows its final result.
enum ResultFormat {
  percentage,
  outOf,
  gpa,

  /// The IB Diploma total: the best subjects' points plus core points, out of 45.
  pointsTotal;

  static ResultFormat? fromWire(Object? value) => switch (value) {
    'percentage' => ResultFormat.percentage,
    'out_of' => ResultFormat.outOf,
    'gpa' => ResultFormat.gpa,
    'points_total' => ResultFormat.pointsTotal,
    _ => null,
  };
}

/// Whether an IB Diploma is awarded; [unknown] for a value this build does not know yet.
enum DiplomaStatus {
  awarded,
  notAwarded,
  pending,
  unknown;

  static DiplomaStatus fromWire(Object? value) => switch (value) {
    'awarded' => awarded,
    'not_awarded' => notAwarded,
    'pending' => pending,
    _ => unknown,
  };
}

/// One failing condition of a diploma ("Total 22 is below 24"). [code] stays the wire string so
/// a condition this build does not know still shows (as its code).
class DiplomaFailingCondition {
  const DiplomaFailingCondition({
    required this.code,
    this.required,
    this.actual,
    this.component,
    this.grade,
    this.level,
    this.points,
  });

  factory DiplomaFailingCondition.fromJson(Map<String, Object?> json) =>
      DiplomaFailingCondition(
        code: json['code'] as String? ?? '',
        required: _num(json['required']),
        actual: _num(json['actual']),
        component: _text(json['component']),
        grade: _text(json['grade']),
        level: _text(json['level']),
        points: _num(json['points']),
      );

  final String code;
  final double? required;
  final double? actual;

  /// `tok` or `ee` (CORE_GRADE).
  final String? component;
  final String? grade;
  final String? level;
  final double? points;
}

/// The IB Diploma outcome of a points_total result (000262): the total out of 45, core points,
/// the TOK / Extended Essay / CAS used and whether the diploma is awarded. Also the predicted
/// total (from predicted grades), which has the same shape.
class DiplomaOutcome {
  const DiplomaOutcome({
    required this.status,
    required this.total,
    required this.max,
    required this.subjectPoints,
    required this.corePoints,
    required this.tokGrade,
    required this.eeGrade,
    required this.casComplete,
    required this.failingConditions,
    required this.pendingReasons,
  });

  /// Null for anything that isn't a diploma object (results of every other format, and results
  /// and documents from before the diploma total).
  static DiplomaOutcome? fromJson(Object? json) {
    if (json is! Map) return null;
    return DiplomaOutcome(
      status: DiplomaStatus.fromWire(json['status']),
      total: _num(json['total']),
      max: _num(json['max']) ?? 45,
      subjectPoints: _num(json['subject_points']),
      corePoints: _num(json['core_points']),
      tokGrade: _text(json['tok_grade']),
      eeGrade: _text(json['ee_grade']),
      casComplete: json['cas_complete'] as bool?,
      failingConditions: [
        for (final row in _list(json['failing_conditions']))
          DiplomaFailingCondition.fromJson(row),
      ],
      pendingReasons: [
        for (final reason
            in (json['pending_reasons'] as List<Object?>?) ?? const [])
          if (reason is String) reason,
      ],
    );
  }

  final DiplomaStatus status;

  /// Null while pending (TOK/EE grade or a subject result missing).
  final double? total;
  final double max;
  final double? subjectPoints;
  final double? corePoints;
  final String? tokGrade;
  final String? eeGrade;
  final bool? casComplete;
  final List<DiplomaFailingCondition> failingConditions;

  /// `subjects_incomplete`, `core_grades_missing`, `cas_not_recorded` (unknown ones are kept).
  final List<String> pendingReasons;
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
    this.weightedGpa,
    this.creditsAttempted,
    this.creditsEarned,
    this.classRank,
    this.diploma,
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
    // Absent from older servers and documents: no weighted GPA, no credits.
    weightedGpa: _num(json['weighted_gpa']),
    creditsAttempted: _num(json['credits_attempted']),
    creditsEarned: _num(json['credits_earned']),
    // Absent when the grade does not rank, the school keeps it for staff, and on older results.
    classRank: ClassRank.fromJson(json['class_rank']),
    // IB Diploma grades only; absent on every other result and on older ones.
    diploma: DiplomaOutcome.fromJson(json['diploma']),
  );

  final double? averagePercentage;
  final double? totalObtained;
  final double? totalMax;
  final String? gradeLabel;
  final int subjectsFailed;
  final AcademicStatus academicStatus;
  final ResultDisplay? display;

  /// The GPA with Honors/AP/HL boosts, beside a GPA [display]; null when there is none.
  final double? weightedGpa;

  /// Credits of the counted subjects, and of those passed; null when none carries credits.
  final double? creditsAttempted;
  final double? creditsEarned;

  /// Where the result places the student in their section or grade; null when not shown.
  final ClassRank? classRank;

  /// The IB Diploma total, core points and award status; null for every other result format.
  final DiplomaOutcome? diploma;
}

/// A class rank's state: a place, a result that takes none (incomplete), or a grade-wide rank
/// waiting for every section to be finalized.
enum ClassRankStatus { ranked, notRanked, pending }

/// A finalized result's class rank ("3rd of 120", 84th percentile), from a result's `class_rank`
/// or the rank an issued certificate or transcript kept (which carries no status: always ranked).
class ClassRank {
  const ClassRank({
    required this.status,
    this.rank,
    this.cohortSize,
    this.percentile,
  });

  /// Null for anything that isn't a rank this build understands, so an unknown status shows nothing.
  static ClassRank? fromJson(Object? json) {
    if (json is! Map) return null;
    final rank = _int(json['rank']);
    final cohortSize = _int(json['cohort_size']);
    final percentile = _int(json['percentile']);
    final status = switch (json['status']) {
      'ranked' => ClassRankStatus.ranked,
      'not_ranked' => ClassRankStatus.notRanked,
      'pending' => ClassRankStatus.pending,
      // A document's rank has no status: it was ranked when issued.
      null when rank != null => ClassRankStatus.ranked,
      _ => null,
    };
    if (status == null) return null;
    if (status == ClassRankStatus.ranked &&
        (rank == null || cohortSize == null)) {
      return null;
    }
    return ClassRank(
      status: status,
      rank: rank,
      cohortSize: cohortSize,
      percentile: percentile,
    );
  }

  final ClassRankStatus status;

  /// 1 for the best; tied students share a place (1, 2, 2, 4).
  final int? rank;

  /// How many students were ranked.
  final int? cohortSize;

  /// The whole-number share of ranked students with a lower result.
  final int? percentile;
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
    this.language,
    this.schoolNameAr,
    this.academicYearNameAr,
    this.termNameAr,
    this.studentNameAr,
    this.gradeLevelNameAr,
    this.sectionNameAr,
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
      // Arabic + English documents (000263): absent on documents issued before.
      language: DocumentLanguage.fromWire(json['language']),
      schoolNameAr: arabicNameOf(_map(json['school'])['name_ar']),
      academicYearNameAr: arabicNameOf(_map(json['academic_year'])['name_ar']),
      termNameAr: term is Map ? arabicNameOf(term['name_ar']) : null,
      studentNameAr: studentArabicName(student),
      gradeLevelNameAr: arabicNameOf(json['grade_level_name_ar']),
      sectionNameAr: arabicNameOf(json['section_name_ar']),
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

  /// The language it was issued in; null follows the app's language.
  final DocumentLanguage? language;

  /// The Arabic names at issue; null when there were none.
  final String? schoolNameAr;
  final String? academicYearNameAr;
  final String? termNameAr;
  final String? studentNameAr;
  final String? gradeLevelNameAr;
  final String? sectionNameAr;
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

int? _int(Object? value) => value is num ? value.toInt() : null;

/// A non-blank string, or null.
String? _text(Object? value) =>
    value is String && value.trim().isNotEmpty ? value : null;
