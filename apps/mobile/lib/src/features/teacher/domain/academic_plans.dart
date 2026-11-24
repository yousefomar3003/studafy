/// Learning outcome achievement and lesson and term plans (000267), from
/// `/api/grading/sections/{sectionId}/subjects/{subjectId}/outcome-achievements`, `.../term-plans`,
/// `.../lesson-plans`, `/api/grading/term-plans/{id}`, `/api/grading/lesson-plans/{id}` and
/// `/api/grading/plan-reviews`. Hand-written and parsed defensively like `predicted_grades.dart`: a
/// missing field reads as empty or read-only and an unknown status as [PlanStatus.unknown], so an
/// older app keeps working against a newer API.
library;

/// One outcome of the catalogue, as plans and achievement pick it.
class OutcomeRef {
  const OutcomeRef({
    required this.id,
    required this.code,
    required this.text,
    this.textAr,
    this.strand,
    this.archived = false,
  });

  factory OutcomeRef.fromJson(Map<String, Object?> json) => OutcomeRef(
    id: json['id'] as String? ?? '',
    code: json['code'] as String? ?? '',
    text: json['text'] as String? ?? '',
    textAr: _text(json['text_ar']),
    strand: _text(json['strand']),
    archived: json['archived'] == true,
  );

  final String id;
  final String code;
  final String text;
  final String? textAr;
  final String? strand;
  final bool archived;

  /// The text in the app's language, falling back to English.
  String textFor(String languageCode) =>
      (languageCode == 'ar' ? textAr : null) ?? text;
}

/// One level of the school's achievement scale (1 = lowest).
class AchievementLevel {
  const AchievementLevel({
    required this.level,
    required this.label,
    this.labelAr,
  });

  factory AchievementLevel.fromJson(Map<String, Object?> json) =>
      AchievementLevel(
        level: (json['level'] as num?)?.toInt() ?? 0,
        label: json['label'] as String? ?? '',
        labelAr: _text(json['label_ar']),
      );

  final int level;
  final String label;
  final String? labelAr;

  String labelFor(String languageCode) =>
      (languageCode == 'ar' ? labelAr : null) ?? label;
}

/// A section's achievement in one subject and period.
class SectionOutcomeAchievements {
  const SectionOutcomeAchievements({
    required this.subjectName,
    required this.sectionLabel,
    required this.termId,
    required this.editable,
    required this.finalized,
    required this.levels,
    required this.terms,
    required this.outcomes,
    required this.students,
  });

  factory SectionOutcomeAchievements.fromJson(Map<String, Object?> json) {
    final grade = json['grade_level_name'] as String? ?? '';
    final section = json['section_name'] as String? ?? '';
    return SectionOutcomeAchievements(
      subjectName: json['subject_name'] as String? ?? '',
      sectionLabel: [grade, section].where((s) => s.isNotEmpty).join(' '),
      termId: json['term_id'] as String?,
      // A coordinator, or a server that does not say, reads only.
      editable: json['editable'] == true,
      finalized: json['finalized'] == true,
      levels: [
        for (final level in _list(json['levels']))
          AchievementLevel.fromJson(level),
      ]..removeWhere((level) => level.level <= 0),
      terms: [
        for (final term in _list(json['terms']))
          if (term['term_id'] is String)
            (
              termId: term['term_id']! as String,
              name: term['term_name'] as String? ?? '',
            ),
      ],
      outcomes: [
        for (final outcome in _list(json['outcomes']))
          if (outcome['id'] is String) OutcomeRef.fromJson(outcome),
      ],
      students: [
        for (final student in _list(json['students']))
          if (student['student_id'] is String)
            (
              studentId: student['student_id']! as String,
              name:
                  '${student['first_name'] as String? ?? ''} '
                          '${student['last_name'] as String? ?? ''}'
                      .trim(),
              levels: {
                for (final value in _list(student['achievements']))
                  if (value['outcome_id'] is String && value['level'] is num)
                    value['outcome_id']! as String: (value['level']! as num)
                        .toInt(),
              },
            ),
      ],
    );
  }

  final String subjectName;
  final String sectionLabel;
  final String? termId;
  final bool editable;
  final bool finalized;
  final List<AchievementLevel> levels;
  final List<({String termId, String name})> terms;
  final List<OutcomeRef> outcomes;

  /// Each student's level per outcome id.
  final List<({String studentId, String name, Map<String, int> levels})>
  students;
}

/// A plan's review status. An unknown value (a newer server) reads as [unknown], shown neutrally
/// and never editable.
enum PlanStatus {
  draft,
  submitted,
  approved,
  returned,
  unknown;

  static PlanStatus fromWire(Object? value) => switch (value) {
    'draft' => draft,
    'submitted' => submitted,
    'approved' => approved,
    'returned' => returned,
    _ => unknown,
  };
}

enum PlanKind { term, lesson }

/// What every plan shares: where it belongs, who wrote it, where it is in review.
class PlanHeader {
  const PlanHeader({
    required this.id,
    required this.status,
    required this.subjectName,
    required this.sectionLabel,
    this.termId,
    this.termName,
    this.authorName,
    this.reviewComment,
    this.reviewedByName,
    this.dueOn,
    this.onTime,
    this.canEdit = false,
    this.canSubmit = false,
    this.canDelete = false,
    this.canReview = false,
  });

  factory PlanHeader.fromJson(Map<String, Object?> json) {
    final grade = json['grade_level_name'] as String? ?? '';
    final section = json['section_name'] as String? ?? '';
    return PlanHeader(
      id: json['id'] as String? ?? '',
      status: PlanStatus.fromWire(json['status']),
      subjectName: json['subject_name'] as String? ?? '',
      sectionLabel: [grade, section].where((s) => s.isNotEmpty).join(' '),
      termId: json['term_id'] as String?,
      termName: _text(json['term_name']),
      authorName: _text(json['author_name']),
      reviewComment: _text(json['review_comment']),
      reviewedByName: _text(json['reviewed_by_name']),
      dueOn: DateTime.tryParse(json['due_on'] as String? ?? ''),
      onTime: json['on_time'] as bool?,
      canEdit: json['can_edit'] == true,
      canSubmit: json['can_submit'] == true,
      canDelete: json['can_delete'] == true,
      canReview: json['can_review'] == true,
    );
  }

  final String id;
  final PlanStatus status;
  final String subjectName;
  final String sectionLabel;
  final String? termId;
  final String? termName;
  final String? authorName;
  final String? reviewComment;
  final String? reviewedByName;
  final DateTime? dueOn;

  /// Whether the first submission came by the due day; null until submitted.
  final bool? onTime;
  final bool canEdit;
  final bool canSubmit;
  final bool canDelete;
  final bool canReview;
}

/// A row of a plan list or the review queue.
class PlanSummary {
  const PlanSummary({
    required this.kind,
    required this.header,
    this.lessonDate,
    this.period,
    this.title,
  });

  factory PlanSummary.fromJson(PlanKind kind, Map<String, Object?> json) =>
      PlanSummary(
        kind: kind,
        header: PlanHeader.fromJson(json),
        lessonDate: DateTime.tryParse(json['lesson_date'] as String? ?? ''),
        period: (json['period'] as num?)?.toInt(),
        title: _text(json['title']),
      );

  final PlanKind kind;
  final PlanHeader header;
  final DateTime? lessonDate;
  final int? period;
  final String? title;
}

class TermPlanWeek {
  const TermPlanWeek({
    required this.weekNumber,
    this.unit,
    this.notes,
    this.outcomes = const [],
  });

  factory TermPlanWeek.fromJson(Map<String, Object?> json) => TermPlanWeek(
    weekNumber: (json['week_number'] as num?)?.toInt() ?? 1,
    unit: _text(json['unit']),
    notes: _text(json['notes']),
    outcomes: [
      for (final outcome in _list(json['outcomes']))
        if (outcome['id'] is String) OutcomeRef.fromJson(outcome),
    ],
  );

  final int weekNumber;
  final String? unit;
  final String? notes;
  final List<OutcomeRef> outcomes;

  Map<String, Object?> toJson() => {
    'week_number': weekNumber,
    'unit': unit,
    'notes': notes,
    'outcome_ids': [for (final outcome in outcomes) outcome.id],
  };
}

class TermPlan {
  const TermPlan({required this.header, required this.weeks, this.notes});

  factory TermPlan.fromJson(Map<String, Object?> json) => TermPlan(
    header: PlanHeader.fromJson(json),
    notes: _text(json['notes']),
    weeks: [
      for (final week in _list(json['weeks'])) TermPlanWeek.fromJson(week),
    ],
  );

  final PlanHeader header;
  final String? notes;
  final List<TermPlanWeek> weeks;
}

class LessonPlan {
  const LessonPlan({
    required this.header,
    required this.lessonDate,
    required this.title,
    this.period,
    this.objectives,
    this.activities,
    this.resources,
    this.homework,
    this.reflection,
    this.canReflect = false,
    this.outcomes = const [],
    this.materials = const [],
  });

  factory LessonPlan.fromJson(Map<String, Object?> json) => LessonPlan(
    header: PlanHeader.fromJson(json),
    lessonDate:
        DateTime.tryParse(json['lesson_date'] as String? ?? '') ??
        DateTime.now(),
    title: json['title'] as String? ?? '',
    period: (json['period'] as num?)?.toInt(),
    objectives: _text(json['objectives']),
    activities: _text(json['activities']),
    resources: _text(json['resources']),
    homework: _text(json['homework']),
    reflection: _text(json['reflection']),
    canReflect: json['can_reflect'] == true,
    outcomes: [
      for (final outcome in _list(json['outcomes']))
        if (outcome['id'] is String) OutcomeRef.fromJson(outcome),
    ],
    materials: [
      for (final material in _list(json['materials']))
        if (material['id'] is String)
          (
            id: material['id']! as String,
            title: material['title'] as String? ?? '',
          ),
    ],
  );

  final PlanHeader header;
  final DateTime lessonDate;
  final String title;
  final int? period;
  final String? objectives;
  final String? activities;
  final String? resources;
  final String? homework;
  final String? reflection;
  final bool canReflect;
  final List<OutcomeRef> outcomes;
  final List<({String id, String title})> materials;
}

/// What a lesson plan picks from: the date's timetable periods, the class's materials and the
/// grade's active outcomes.
class LessonPlanOptions {
  const LessonPlanOptions({
    this.periods = const [],
    this.materials = const [],
    this.outcomes = const [],
  });

  factory LessonPlanOptions.fromJson(Map<String, Object?> json) =>
      LessonPlanOptions(
        periods: [
          for (final period in (json['periods'] as List<Object?>?) ?? const [])
            if (period is num) period.toInt(),
        ],
        materials: [
          for (final material in _list(json['materials']))
            if (material['id'] is String)
              (
                id: material['id']! as String,
                title: material['title'] as String? ?? '',
              ),
        ],
        outcomes: [
          for (final outcome in _list(json['outcomes']))
            if (outcome['id'] is String) OutcomeRef.fromJson(outcome),
        ],
      );

  final List<int> periods;
  final List<({String id, String title})> materials;
  final List<OutcomeRef> outcomes;
}

/// The plans the signed-in coordinator (or leader) reviews.
class PlanReviewQueue {
  const PlanReviewQueue({required this.plans});

  factory PlanReviewQueue.fromJson(Map<String, Object?> json) =>
      PlanReviewQueue(
        plans: [
          for (final plan in _list(json['term_plans']))
            PlanSummary.fromJson(PlanKind.term, plan),
          for (final plan in _list(json['lesson_plans']))
            PlanSummary.fromJson(PlanKind.lesson, plan),
        ],
      );

  final List<PlanSummary> plans;
}

List<Map<String, Object?>> _list(Object? value) => [
  for (final item in (value as List<Object?>?) ?? const <Object?>[])
    if (item is Map) Map<String, Object?>.from(item),
];

String? _text(Object? value) =>
    value is String && value.trim().isNotEmpty ? value : null;
