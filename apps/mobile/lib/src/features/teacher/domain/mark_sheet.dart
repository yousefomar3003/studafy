/// Domain model for the teacher's academic mark sheets (`/api/grading/...`, OpenAPI tag `Marks`).
///
/// Hand-written rather than the generated `MarksClient` models, for two reasons found while
/// building this feature:
///
/// * The generated roster row (`Students3.preview`) is non-nullable, but the API returns
///   `preview: null` for an exempt student (`MarkPreview` is `["object", "null"]` in the spec), so
///   the generated `fromJson` throws on any sheet with an exemption.
/// * The generated names for this surface are positional (`Students3`, `Assessments4`, `Terms2`,
///   `Status22`–`Status24`, `Config`) and shift whenever another schema is added to the spec —
///   the same drift that already broke other features' references to `Term` and `Status15`.
///
/// `data/mark_sheet_client.dart` calls the endpoints and hands back these types, whose JSON shapes
/// are the ones documented in the API's `grading/schemas.ts` (`markSheetSchema`).
library;

/// Approval state of one period's mark sheet (a term, or the annual period).
enum MarkSheetPeriodStatus {
  draft,
  submitted,
  approved,
  returned,

  /// A wire value newer than this build. Treated as locked — never editable.
  unknown;

  static MarkSheetPeriodStatus fromWire(Object? value) => switch (value) {
    'draft' => draft,
    'submitted' => submitted,
    'approved' => approved,
    'returned' => returned,
    _ => unknown,
  };

  /// Marks can be recorded while the sheet is a draft, or after a reviewer returned it (saving a
  /// mark on a returned sheet moves it back to draft server-side).
  bool get isOpen => this == draft || this == returned;

  /// Submitted, approved (or unrecognised) — the API answers `MARKS_LOCKED` to any write.
  bool get isLocked => !isOpen;
}

/// How a recorded mark counts. `pending` is not a stored state — it is only sent to clear a mark.
enum MarkStatus {
  graded('graded'),
  absent('absent'),
  excused('excused'),
  notApplicable('not_applicable');

  const MarkStatus(this.wire);

  final String wire;

  static MarkStatus? fromWire(Object? value) {
    for (final status in values) {
      if (status.wire == value) return status;
    }
    return null;
  }
}

/// One section + subject the signed-in teacher grades, from `GET /api/grading/my-assignments`.
class GradingAssignment {
  const GradingAssignment({
    required this.academicYearId,
    required this.sectionId,
    required this.sectionName,
    required this.gradeLevelName,
    required this.subjectId,
    required this.subjectName,
    required this.configId,
    required this.sheets,
  });

  factory GradingAssignment.fromJson(Map<String, Object?> json) =>
      GradingAssignment(
        academicYearId: json['academic_year_id']! as String,
        sectionId: json['section_id']! as String,
        sectionName: json['section_name']! as String,
        gradeLevelName: json['grade_level_name']! as String,
        subjectId: json['subject_id']! as String,
        subjectName: json['subject_name']! as String,
        configId: json['config_id']! as String,
        sheets: [
          for (final sheet in _list(json['sheets']))
            (
              termId: sheet['term_id'] as String?,
              status: MarkSheetPeriodStatus.fromWire(sheet['status']),
            ),
        ],
      );

  final String academicYearId;
  final String sectionId;
  final String sectionName;
  final String gradeLevelName;
  final String subjectId;
  final String subjectName;
  final String configId;

  /// Each period's mark-sheet status; `termId` null is the annual period.
  final List<({String? termId, MarkSheetPeriodStatus status})> sheets;

  /// How many periods are in each status — the list row's summary.
  Map<MarkSheetPeriodStatus, int> get statusCounts {
    final counts = <MarkSheetPeriodStatus, int>{};
    for (final sheet in sheets) {
      counts[sheet.status] = (counts[sheet.status] ?? 0) + 1;
    }
    return counts;
  }
}

/// The subject's effective grading rules, as the engine applies them to this section.
class MarkSheetConfig {
  const MarkSheetConfig({
    required this.gradingMethod,
    required this.maxMarks,
    required this.passPercentage,
    required this.finalExamPassPercentage,
    required this.roundingDecimals,
    required this.missingMarkPolicy,
    required this.absentPolicy,
    required this.retakePolicy,
    required this.instructions,
    required this.termCategoryWeightTotal,
    required this.annualWeightTotal,
    required this.weightsValid,
  });

  factory MarkSheetConfig.fromJson(Map<String, Object?> json) {
    final weights = _map(json['weight_summary']);
    return MarkSheetConfig(
      gradingMethod: json['grading_method']! as String,
      maxMarks: _num(json['max_marks']) ?? 100,
      passPercentage: _num(json['pass_percentage']) ?? 0,
      finalExamPassPercentage: _num(json['final_exam_pass_percentage']),
      roundingDecimals: (json['rounding_decimals'] as num?)?.toInt() ?? 0,
      missingMarkPolicy: json['missing_mark_policy'] as String? ?? 'incomplete',
      absentPolicy: json['absent_policy'] as String? ?? 'incomplete',
      retakePolicy: json['retake_policy'] as String? ?? 'none',
      instructions: json['instructions'] as String?,
      termCategoryWeightTotal: _num(weights['termCategoryTotal']),
      annualWeightTotal: _num(weights['annualTotal']),
      weightsValid: weights['valid'] as bool? ?? true,
    );
  }

  /// `weighted` or `total_points`.
  final String gradingMethod;
  final double maxMarks;
  final double passPercentage;
  final double? finalExamPassPercentage;
  final int roundingDecimals;

  /// `incomplete` or `zero` — what a missing mark does to the result.
  final String missingMarkPolicy;

  /// `incomplete` or `zero` — what an absence does to the result.
  final String absentPolicy;

  /// `none`, `replace`, `highest` or `capped`.
  final String retakePolicy;
  final String? instructions;
  final double? termCategoryWeightTotal;
  final double? annualWeightTotal;
  final bool weightsValid;

  /// A second attempt (`attempt: 2`) is accepted only when the subject has a retake policy.
  bool get allowsRetake => retakePolicy != 'none';
}

class MarkSheetTerm {
  const MarkSheetTerm({
    required this.id,
    required this.name,
    required this.sequenceNumber,
    required this.weight,
  });

  factory MarkSheetTerm.fromJson(Map<String, Object?> json) => MarkSheetTerm(
    id: json['id']! as String,
    name: json['name']! as String,
    sequenceNumber: (json['sequence_number'] as num?)?.toInt() ?? 0,
    weight: _num(json['weight']) ?? 0,
  );

  final String id;
  final String name;
  final int sequenceNumber;
  final double weight;
}

class MarkSheetCategory {
  const MarkSheetCategory({
    required this.id,
    required this.name,
    required this.kind,
    required this.scope,
    required this.weight,
    required this.aggregation,
    required this.dropLowest,
  });

  factory MarkSheetCategory.fromJson(Map<String, Object?> json) =>
      MarkSheetCategory(
        id: json['id']! as String,
        name: json['name']! as String,
        kind: json['kind'] as String? ?? 'other',
        scope: json['scope'] as String? ?? 'annual',
        weight: _num(json['weight']),
        aggregation: json['aggregation'] as String? ?? 'weighted_average',
        dropLowest: (json['drop_lowest'] as num?)?.toInt() ?? 0,
      );

  final String id;
  final String name;
  final String kind;

  /// `term` or `annual`.
  final String scope;

  /// Share of the period's result, in percent. Null under total-points grading.
  final double? weight;
  final String aggregation;
  final int dropLowest;
}

class MarkSheetAssessment {
  const MarkSheetAssessment({
    required this.id,
    required this.categoryId,
    required this.termId,
    required this.name,
    required this.maxMarks,
    required this.weight,
    required this.isMandatory,
    required this.status,
    required this.sectionSpecific,
  });

  factory MarkSheetAssessment.fromJson(Map<String, Object?> json) =>
      MarkSheetAssessment(
        id: json['id']! as String,
        categoryId: json['category_id']! as String,
        termId: json['term_id'] as String?,
        name: json['name']! as String,
        maxMarks: _num(json['max_marks']) ?? 0,
        weight: _num(json['weight']) ?? 1,
        isMandatory: json['is_mandatory'] as bool? ?? true,
        status: json['status'] as String? ?? 'active',
        sectionSpecific: json['section_specific'] as bool? ?? false,
      );

  final String id;
  final String categoryId;

  /// Null for an annual assessment.
  final String? termId;
  final String name;
  final double maxMarks;
  final double weight;
  final bool isMandatory;

  /// `active`, `proposed` (a teacher-added assessment awaiting approval) or `rejected`.
  final String status;
  final bool sectionSpecific;

  /// Only active assessments accept marks and count towards the result.
  bool get isActive => status == 'active';
  bool get isProposed => status == 'proposed';
}

/// One period's mark sheet. A period with no stored sheet yet is reported as a `draft` with a
/// null [id].
class MarkSheetPeriod {
  const MarkSheetPeriod({
    required this.id,
    required this.termId,
    required this.status,
    required this.submittedAt,
    required this.decidedAt,
    required this.returnReason,
  });

  factory MarkSheetPeriod.fromJson(Map<String, Object?> json) =>
      MarkSheetPeriod(
        id: json['id'] as String?,
        termId: json['term_id'] as String?,
        status: MarkSheetPeriodStatus.fromWire(json['status']),
        submittedAt: _date(json['submitted_at']),
        decidedAt: _date(json['decided_at']),
        returnReason: json['return_reason'] as String?,
      );

  final String? id;

  /// Null for the annual period.
  final String? termId;
  final MarkSheetPeriodStatus status;
  final DateTime? submittedAt;
  final DateTime? decidedAt;
  final String? returnReason;
}

/// A mark as recorded. [updatedAt] is kept as the exact wire string: it is echoed back as
/// `expected_updated_at`, the optimistic-concurrency token.
class RecordedMark {
  const RecordedMark({
    required this.id,
    required this.assessmentId,
    required this.attempt,
    required this.status,
    required this.score,
    required this.remarks,
    required this.updatedAt,
  });

  factory RecordedMark.fromJson(Map<String, Object?> json) => RecordedMark(
    id: json['id']! as String,
    assessmentId: json['assessment_id']! as String,
    attempt: (json['attempt'] as num?)?.toInt() ?? 1,
    status: MarkStatus.fromWire(json['status']) ?? MarkStatus.graded,
    score: _num(json['score']),
    remarks: json['remarks'] as String?,
    updatedAt: json['updated_at']! as String,
  );

  final String id;
  final String assessmentId;
  final int attempt;
  final MarkStatus status;
  final double? score;
  final String? remarks;
  final String updatedAt;
}

/// The engine's live calculation for one student. [percentage] is set only when [isComplete];
/// otherwise [provisionalPercentage] is the result so far, which is never a final grade.
class MarkPreview {
  const MarkPreview({
    required this.isComplete,
    required this.percentage,
    required this.provisionalPercentage,
    required this.gradeLabel,
    required this.passed,
    required this.missingAssessmentIds,
    required this.termPercentages,
  });

  factory MarkPreview.fromJson(Map<String, Object?> json) => MarkPreview(
    isComplete: json['status'] == 'complete',
    percentage: _num(json['percentage']),
    provisionalPercentage: _num(json['provisional_percentage']),
    gradeLabel: json['grade_label'] as String?,
    passed: json['passed'] as bool?,
    missingAssessmentIds: [
      for (final id
          in (json['missing_assessment_ids'] as List<Object?>?) ??
              const <Object?>[])
        id! as String,
    ],
    termPercentages: [
      for (final term in _list(json['terms']))
        (
          termId: term['term_id'] as String?,
          percentage: _num(term['percentage']),
          incomplete: term['incomplete'] as bool? ?? false,
        ),
    ],
  );

  final bool isComplete;
  final double? percentage;
  final double? provisionalPercentage;
  final String? gradeLabel;
  final bool? passed;
  final List<String> missingAssessmentIds;
  final List<({String? termId, double? percentage, bool incomplete})>
  termPercentages;
}

class MarkSheetStudent {
  const MarkSheetStudent({
    required this.studentId,
    required this.firstName,
    required this.lastName,
    required this.admissionNumber,
    required this.isExempt,
    required this.marks,
    required this.preview,
  });

  factory MarkSheetStudent.fromJson(Map<String, Object?> json) {
    final preview = json['preview'];
    return MarkSheetStudent(
      studentId: json['student_id']! as String,
      firstName: json['first_name'] as String? ?? '',
      lastName: json['last_name'] as String? ?? '',
      admissionNumber: json['admission_number'] as String? ?? '',
      isExempt: json['status'] == 'exempt',
      marks: [
        for (final mark in _list(json['marks'])) RecordedMark.fromJson(mark),
      ],
      preview: preview is Map
          ? MarkPreview.fromJson(Map<String, Object?>.from(preview))
          : null,
    );
  }

  final String studentId;
  final String firstName;
  final String lastName;
  final String admissionNumber;

  /// Exempt from the subject: takes no marks and has no [preview].
  final bool isExempt;
  final List<RecordedMark> marks;
  final MarkPreview? preview;

  String get displayName => '$firstName $lastName'.trim();

  RecordedMark? markFor(String assessmentId, {int attempt = 1}) {
    for (final mark in marks) {
      if (mark.assessmentId == assessmentId && mark.attempt == attempt) {
        return mark;
      }
    }
    return null;
  }
}

/// `GET /api/grading/sections/{sectionId}/subjects/{subjectId}/marks`.
class MarkSheet {
  const MarkSheet({
    required this.sectionId,
    required this.sectionName,
    required this.gradeLevelName,
    required this.subjectId,
    required this.subjectCode,
    required this.subjectName,
    required this.yearStatus,
    required this.canEditMarks,
    required this.canAddAssessments,
    required this.config,
    required this.terms,
    required this.categories,
    required this.assessments,
    required this.periods,
    required this.students,
  });

  factory MarkSheet.fromJson(Map<String, Object?> json) {
    final section = _map(json['section']);
    final subject = _map(json['subject']);
    final terms = [
      for (final term in _list(json['terms'])) MarkSheetTerm.fromJson(term),
    ]..sort((a, b) => a.sequenceNumber.compareTo(b.sequenceNumber));
    return MarkSheet(
      sectionId: section['id']! as String,
      sectionName: section['name'] as String? ?? '',
      gradeLevelName: section['grade_level_name'] as String? ?? '',
      subjectId: subject['id']! as String,
      subjectCode: subject['code'] as String? ?? '',
      subjectName: subject['name'] as String? ?? '',
      yearStatus: json['year_status'] as String? ?? 'active',
      canEditMarks: json['can_edit_marks'] as bool? ?? false,
      canAddAssessments: json['can_add_assessments'] as bool? ?? false,
      config: MarkSheetConfig.fromJson(_map(json['config'])),
      terms: terms,
      categories: [
        for (final category in _list(json['categories']))
          MarkSheetCategory.fromJson(category),
      ],
      assessments: [
        for (final assessment in _list(json['assessments']))
          MarkSheetAssessment.fromJson(assessment),
      ],
      periods: [
        for (final period in _list(json['mark_sheets']))
          MarkSheetPeriod.fromJson(period),
      ],
      students: [
        for (final student in _list(json['students']))
          MarkSheetStudent.fromJson(student),
      ],
    );
  }

  final String sectionId;
  final String sectionName;
  final String gradeLevelName;
  final String subjectId;
  final String subjectCode;
  final String subjectName;

  /// The year's grading configuration lifecycle: `draft`, `active`, `finalized`, `archived`.
  final String yearStatus;

  /// False outside an active year — every mark is read-only.
  final bool canEditMarks;
  final bool canAddAssessments;
  final MarkSheetConfig config;

  /// Ascending by sequence number.
  final List<MarkSheetTerm> terms;
  final List<MarkSheetCategory> categories;
  final List<MarkSheetAssessment> assessments;

  /// One per period, in the server's order (terms, then the annual period when it has
  /// assessments).
  final List<MarkSheetPeriod> periods;
  final List<MarkSheetStudent> students;

  MarkSheetPeriod? periodFor(String? termId) {
    for (final period in periods) {
      if (period.termId == termId) return period;
    }
    return null;
  }

  MarkSheetTerm? termById(String? termId) {
    if (termId == null) return null;
    for (final term in terms) {
      if (term.id == termId) return term;
    }
    return null;
  }

  MarkSheetCategory? categoryById(String id) {
    for (final category in categories) {
      if (category.id == id) return category;
    }
    return null;
  }

  MarkSheetAssessment? assessmentById(String id) {
    for (final assessment in assessments) {
      if (assessment.id == id) return assessment;
    }
    return null;
  }

  MarkSheetStudent? studentById(String id) {
    for (final student in students) {
      if (student.studentId == id) return student;
    }
    return null;
  }

  /// Every assessment of a period (`termId` null = annual), proposed/rejected ones included.
  List<MarkSheetAssessment> assessmentsFor(String? termId) => [
    for (final assessment in assessments)
      if (assessment.termId == termId) assessment,
  ];

  /// The period's assessments grouped by category, in the configuration's category order.
  /// Categories with no assessment in the period are left out.
  List<({MarkSheetCategory? category, List<MarkSheetAssessment> assessments})>
  assessmentGroupsFor(String? termId) {
    final inPeriod = assessmentsFor(termId);
    final groups =
        <
          ({MarkSheetCategory? category, List<MarkSheetAssessment> assessments})
        >[];
    final seen = <String>{};
    for (final category in categories) {
      final rows = [
        for (final assessment in inPeriod)
          if (assessment.categoryId == category.id) assessment,
      ];
      seen.add(category.id);
      if (rows.isNotEmpty) groups.add((category: category, assessments: rows));
    }
    final orphans = [
      for (final assessment in inPeriod)
        if (!seen.contains(assessment.categoryId)) assessment,
    ];
    if (orphans.isNotEmpty) groups.add((category: null, assessments: orphans));
    return groups;
  }

  /// Whether marks for [termId]'s period can be written right now: the year is active and the
  /// period's sheet is a draft or returned.
  bool isPeriodEditable(String? termId) {
    if (!canEditMarks) return false;
    final period = periodFor(termId);
    return period == null || period.status.isOpen;
  }

  /// Whether [student]'s mark for [assessment] can be written right now.
  bool isCellEditable(
    MarkSheetAssessment assessment,
    MarkSheetStudent student,
  ) =>
      assessment.isActive &&
      !student.isExempt &&
      isPeriodEditable(assessment.termId);

  /// The mandatory, active assessments of [termId]'s period the engine still reports as missing
  /// for [student] — what blocks submitting that period.
  List<MarkSheetAssessment> missingFor(
    MarkSheetStudent student,
    String? termId,
  ) {
    final preview = student.preview;
    if (student.isExempt || preview == null) return const [];
    final missing = preview.missingAssessmentIds.toSet();
    return [
      for (final assessment in assessmentsFor(termId))
        if (missing.contains(assessment.id)) assessment,
    ];
  }

  /// Enrolled students with at least one missing mark in [termId]'s period.
  List<MarkSheetStudent> studentsMissingMarks(String? termId) => [
    for (final student in students)
      if (missingFor(student, termId).isNotEmpty) student,
  ];

  /// How many enrolled students have a recorded first-attempt mark (of any status) for
  /// [assessment].
  int recordedCount(MarkSheetAssessment assessment) => students
      .where(
        (student) =>
            !student.isExempt && student.markFor(assessment.id) != null,
      )
      .length;

  int get enrolledCount => students.where((s) => !s.isExempt).length;
}

/// One write in a `PUT .../marks` batch. [status] `pending` clears the mark.
class MarkEntryInput {
  const MarkEntryInput({
    required this.assessmentId,
    required this.studentId,
    required this.attempt,
    required this.status,
    required this.score,
    this.remarks,
    this.expectedUpdatedAt,
  });

  final String assessmentId;
  final String studentId;
  final int attempt;

  /// A [MarkStatus.wire] value, or `pending` to clear.
  final String status;
  final double? score;
  final String? remarks;
  final String? expectedUpdatedAt;

  Map<String, Object?> toJson() => {
    'assessment_id': assessmentId,
    'student_id': studentId,
    'attempt': attempt,
    'status': status,
    'score': score,
    'remarks': remarks,
    'expected_updated_at': expectedUpdatedAt,
  };
}

List<Map<String, Object?>> _list(Object? value) => [
  for (final item in (value as List<Object?>?) ?? const <Object?>[])
    Map<String, Object?>.from(item! as Map),
];

Map<String, Object?> _map(Object? value) =>
    value is Map ? Map<String, Object?>.from(value) : const {};

double? _num(Object? value) => value is num ? value.toDouble() : null;

DateTime? _date(Object? value) =>
    value is String ? DateTime.tryParse(value) : null;
