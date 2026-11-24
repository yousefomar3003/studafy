/// Remedial plans (000269), from the `Remedial plans` API: a plan to help a struggling student
/// catch up in one subject, for a term or the whole year. Hand-written and parsed defensively like
/// `predicted_grades.dart`: a missing field degrades to an empty or read-only value and an unknown
/// enum value to a neutral one, so an older app keeps working against a newer API.
library;

/// open -> in_progress -> achieved / closed. [unknown]: a status this app does not know yet.
enum RemedialPlanStatus {
  open,
  inProgress,
  achieved,
  closed,
  unknown;

  static RemedialPlanStatus parse(Object? value) => switch (value) {
    'open' => open,
    'in_progress' => inProgress,
    'achieved' => achieved,
    'closed' => closed,
    _ => unknown,
  };

  String get wire => switch (this) {
    open => 'open',
    inProgress => 'in_progress',
    achieved => 'achieved',
    closed => 'closed',
    unknown => 'unknown',
  };

  /// Open or in progress: the plan is still being worked on.
  bool get isActive => this == open || this == inProgress;

  /// Where a status may move (the API refuses anything else).
  List<RemedialPlanStatus> get next => switch (this) {
    open => const [inProgress, achieved, closed],
    inProgress => const [achieved, closed],
    _ => const [],
  };
}

/// Why the plan was opened. [unknown]: a reason this app does not know yet.
enum RemedialPlanReason {
  belowPass,
  teacherConcern,
  unknown;

  static RemedialPlanReason parse(Object? value) => switch (value) {
    'below_pass' => belowPass,
    'teacher_concern' => teacherConcern,
    _ => unknown,
  };

  String get wire => switch (this) {
    belowPass => 'below_pass',
    _ => 'teacher_concern',
  };
}

/// How the caller reaches a plan. An unknown value is treated as read-only [family].
enum RemedialPlanAccess {
  leadership,
  teacher,
  coordinator,
  family;

  static RemedialPlanAccess parse(Object? value) => switch (value) {
    'leadership' => leadership,
    'teacher' => teacher,
    'coordinator' => coordinator,
    _ => family,
  };
}

/// A plan in a list: who, what, where it stands and when it is next reviewed.
class RemedialPlanSummary {
  const RemedialPlanSummary({
    required this.id,
    required this.termId,
    required this.termName,
    required this.sectionLabel,
    required this.studentId,
    required this.studentName,
    required this.subjectName,
    required this.reason,
    required this.status,
    required this.sharedWithFamily,
    required this.nextReviewOn,
    required this.overdue,
  });

  factory RemedialPlanSummary.fromJson(Map<String, Object?> json) {
    final grade = json['grade_level_name'] as String? ?? '';
    final section = json['section_name'] as String? ?? '';
    return RemedialPlanSummary(
      id: json['id'] as String? ?? '',
      termId: json['term_id'] as String?,
      termName: json['term_name'] as String?,
      sectionLabel: [grade, section].where((s) => s.isNotEmpty).join(' '),
      studentId: json['student_id'] as String? ?? '',
      studentName: _name(json['student_first_name'], json['student_last_name']),
      subjectName: json['subject_name'] as String? ?? '',
      reason: RemedialPlanReason.parse(json['reason']),
      status: RemedialPlanStatus.parse(json['status']),
      sharedWithFamily: json['shared_with_family'] == true,
      nextReviewOn: _date(json['next_review_on']),
      overdue: json['overdue'] == true,
    );
  }

  final String id;

  /// Null: the whole year.
  final String? termId;
  final String? termName;

  /// "Grade 10 A".
  final String sectionLabel;
  final String studentId;
  final String studentName;
  final String subjectName;
  final RemedialPlanReason reason;
  final RemedialPlanStatus status;
  final bool sharedWithFamily;

  /// The earliest review not done yet.
  final DateTime? nextReviewOn;

  /// An active plan with a past review not done yet.
  final bool overdue;
}

/// One review date; done once someone following the plan adds a note on or after it.
typedef RemedialReview = ({DateTime reviewOn, bool done, bool overdue});

/// One entry of the plan's timeline.
class RemedialNote {
  const RemedialNote({
    required this.id,
    required this.isStatusChange,
    required this.body,
    required this.newStatus,
    required this.internal,
    required this.authorName,
    required this.authorAccess,
    required this.createdAt,
  });

  factory RemedialNote.fromJson(Map<String, Object?> json) => RemedialNote(
    id: json['id'] as String? ?? '',
    isStatusChange: json['kind'] == 'status_change',
    body: json['body'] as String?,
    newStatus: json['new_status'] == null
        ? null
        : RemedialPlanStatus.parse(json['new_status']),
    internal: json['internal'] == true,
    authorName: json['author_name'] as String?,
    authorAccess: RemedialPlanAccess.parse(json['author_access']),
    createdAt: DateTime.tryParse(json['created_at'] as String? ?? ''),
  );

  final String id;
  final bool isStatusChange;
  final String? body;
  final RemedialPlanStatus? newStatus;

  /// Staff only (the student and parents never receive these).
  final bool internal;
  final String? authorName;
  final RemedialPlanAccess authorAccess;
  final DateTime? createdAt;
}

/// A plan with its targets, reviews and timeline, and what the caller may do with it.
class RemedialPlan {
  const RemedialPlan({
    required this.summary,
    required this.reasonNote,
    required this.targets,
    required this.actions,
    required this.startPercentage,
    required this.passPercentage,
    required this.reviews,
    required this.notes,
    required this.access,
    required this.canEdit,
    required this.canAddNote,
    required this.familySharingEnabled,
  });

  factory RemedialPlan.fromJson(Map<String, Object?> json) => RemedialPlan(
    summary: RemedialPlanSummary.fromJson(json),
    reasonNote: json['reason_note'] as String?,
    targets: json['targets'] as String? ?? '',
    actions: json['actions'] as String? ?? '',
    startPercentage: (json['start_percentage'] as num?)?.toDouble(),
    passPercentage: (json['pass_percentage'] as num?)?.toDouble(),
    reviews: [
      for (final review in _list(json['reviews']))
        if (_date(review['review_on']) case final reviewOn?)
          (
            reviewOn: reviewOn,
            done: review['completed_at'] is String,
            overdue: review['overdue'] == true,
          ),
    ],
    notes: [
      for (final note in _list(json['notes'])) RemedialNote.fromJson(note),
    ],
    access: RemedialPlanAccess.parse(json['access']),
    canEdit: json['can_edit'] == true,
    canAddNote: json['can_add_note'] == true,
    familySharingEnabled: json['family_sharing_enabled'] == true,
  );

  final RemedialPlanSummary summary;
  final String? reasonNote;
  final String targets;
  final String actions;
  final double? startPercentage;
  final double? passPercentage;
  final List<RemedialReview> reviews;
  final List<RemedialNote> notes;
  final RemedialPlanAccess access;
  final bool canEdit;
  final bool canAddNote;
  final bool familySharingEnabled;

  String get id => summary.id;
}

/// A student below the pass line on their current marks.
typedef RemedialSuggestion = ({
  String studentId,
  String name,
  double percentage,
  bool provisional,
  String? activePlanId,
});

/// A section's subject: its plans, the students taking it and the suggestions for a period.
class SectionRemedialPlans {
  const SectionRemedialPlans({
    required this.sectionId,
    required this.subjectId,
    required this.subjectName,
    required this.sectionLabel,
    required this.termId,
    required this.terms,
    required this.access,
    required this.canCreate,
    required this.familySharingEnabled,
    required this.passPercentage,
    required this.students,
    required this.suggestions,
    required this.plans,
  });

  factory SectionRemedialPlans.fromJson(Map<String, Object?> json) {
    final grade = json['grade_level_name'] as String? ?? '';
    final section = json['section_name'] as String? ?? '';
    return SectionRemedialPlans(
      sectionId: json['section_id'] as String? ?? '',
      subjectId: json['subject_id'] as String? ?? '',
      subjectName: json['subject_name'] as String? ?? '',
      sectionLabel: [grade, section].where((s) => s.isNotEmpty).join(' '),
      termId: json['term_id'] as String?,
      terms: [
        for (final term in _list(json['terms']))
          if (term['term_id'] is String)
            (
              termId: term['term_id']! as String,
              name: term['term_name'] as String? ?? '',
            ),
      ],
      access: RemedialPlanAccess.parse(json['access']),
      canCreate: json['can_create'] == true,
      familySharingEnabled: json['family_sharing_enabled'] == true,
      passPercentage: (json['pass_percentage'] as num?)?.toDouble(),
      students: [
        for (final student in _list(json['students']))
          if (student['student_id'] is String)
            (
              studentId: student['student_id']! as String,
              name: _name(student['first_name'], student['last_name']),
            ),
      ],
      suggestions: [
        for (final row in _list(json['suggestions']))
          if (row['student_id'] is String && row['percentage'] is num)
            (
              studentId: row['student_id']! as String,
              name: _name(row['first_name'], row['last_name']),
              percentage: (row['percentage']! as num).toDouble(),
              provisional: row['provisional'] == true,
              activePlanId: row['active_plan_id'] as String?,
            ),
      ],
      plans: [
        for (final plan in _list(json['plans']))
          RemedialPlanSummary.fromJson(plan),
      ],
    );
  }

  final String sectionId;
  final String subjectId;
  final String subjectName;
  final String sectionLabel;

  /// The period the suggestions are for; null: the whole year.
  final String? termId;
  final List<({String termId, String name})> terms;

  /// teacher, coordinator or leadership.
  final RemedialPlanAccess access;

  /// The caller teaches the subject here (or is leadership) and the year is open.
  final bool canCreate;
  final bool familySharingEnabled;

  /// Null for a descriptive subject (no suggestions).
  final double? passPercentage;
  final List<({String studentId, String name})> students;
  final List<RemedialSuggestion> suggestions;
  final List<RemedialPlanSummary> plans;
}

/// The API's limits on what a plan holds.
abstract final class RemedialLimits {
  static const targets = 2000;
  static const actions = 4000;
  static const reasonNote = 1000;
  static const note = 2000;
  static const reviewDates = 12;
}

/// A `YYYY-MM-DD` value as a local calendar date (no time zone can move it a day).
DateTime? _date(Object? value) {
  if (value is! String || value.length < 10) return null;
  final parts = value.substring(0, 10).split('-').map(int.tryParse).toList();
  if (parts.length != 3 || parts.contains(null)) return null;
  return DateTime(parts[0]!, parts[1]!, parts[2]!);
}

/// `YYYY-MM-DD` for the API.
String remedialWireDate(DateTime date) =>
    '${date.year.toString().padLeft(4, '0')}-'
    '${date.month.toString().padLeft(2, '0')}-'
    '${date.day.toString().padLeft(2, '0')}';

String _name(Object? first, Object? last) =>
    '${first as String? ?? ''} ${last as String? ?? ''}'.trim();

List<Map<String, Object?>> _list(Object? value) => [
  for (final item in (value as List<Object?>?) ?? const <Object?>[])
    if (item is Map) Map<String, Object?>.from(item),
];
