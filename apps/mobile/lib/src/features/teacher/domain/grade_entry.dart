/// Domain model for the teacher grade-entry screen.
///
/// Hand-written rather than generated: the `Grade Entry` / `Grade Workflow` OpenAPI tags are
/// excluded from codegen because swagger_parser 1.44.1 mis-generates the `Grade` schema (see
/// `pubspec.yaml`). `data/grade_entry_client.dart` calls the endpoints and hands back these
/// types, whose JSON shapes are stable and documented in the API's `grades/config/schemas.ts`.
library;

/// Lifecycle status of one student's grade submission within a gradebook.
enum GradeSubmissionStatus {
  draft,
  submitted,
  approved,
  rejected,
  published,

  /// A wire value newer than this build. Treated as locked — never editable.
  unknown;

  static GradeSubmissionStatus fromWire(String? value) => switch (value) {
    'draft' => draft,
    'submitted' => submitted,
    'approved' => approved,
    'rejected' => rejected,
    'published' => published,
    _ => unknown,
  };

  /// Cells can only be edited while the submission is still a draft — the API rejects a
  /// `bulkUpdateGrades` touching any non-draft submission with 409.
  bool get isEditable => this == GradeSubmissionStatus.draft;

  /// The teacher has sent this onward for approval (or it is already decided). Shown read-only
  /// with a status chip.
  bool get isLocked =>
      this == GradeSubmissionStatus.submitted ||
      this == GradeSubmissionStatus.approved ||
      this == GradeSubmissionStatus.published ||
      this == GradeSubmissionStatus.unknown;

  /// A rejected submission is editable again only after an admin/teacher unlock; until then it is
  /// neither a live draft nor fully locked.
  bool get isRejected => this == GradeSubmissionStatus.rejected;

  /// Published grades are frozen; the teacher changes them by filing a [GradeRevision] that a
  /// school admin or principal approves.
  bool get isPublished => this == GradeSubmissionStatus.published;
}

/// Lifecycle of a teacher's correction to published grades.
enum GradeRevisionStatus {
  pending,
  approved,
  rejected,
  withdrawn,
  unknown;

  static GradeRevisionStatus fromWire(String? value) => switch (value) {
    'pending' => pending,
    'approved' => approved,
    'rejected' => rejected,
    'withdrawn' => withdrawn,
    _ => unknown,
  };
}

/// One score change inside a [GradeRevision].
class GradeRevisionChange {
  const GradeRevisionChange({
    required this.gradeId,
    required this.previousScore,
    required this.newScore,
  });

  final String gradeId;
  final double? previousScore;
  final double? newScore;

  factory GradeRevisionChange.fromJson(Map<String, Object?> json) =>
      GradeRevisionChange(
        gradeId: json['grade_id']! as String,
        previousScore: (json['previous_score'] as num?)?.toDouble(),
        newScore: (json['new_score'] as num?)?.toDouble(),
      );
}

/// A correction to a published submission, awaiting (or past) approval. The published scores are
/// untouched — students and parents keep seeing them — until it is approved.
class GradeRevision {
  const GradeRevision({
    required this.id,
    required this.status,
    required this.reason,
    required this.rejectionReason,
    required this.changes,
  });

  final String id;
  final GradeRevisionStatus status;
  final String reason;

  /// Set only when [status] is [GradeRevisionStatus.rejected].
  final String? rejectionReason;
  final List<GradeRevisionChange> changes;

  bool get isPending => status == GradeRevisionStatus.pending;
  bool get isRejected => status == GradeRevisionStatus.rejected;

  /// The change this revision proposes for one grade cell, if any.
  GradeRevisionChange? changeFor(String gradeId) {
    for (final change in changes) {
      if (change.gradeId == gradeId) return change;
    }
    return null;
  }

  factory GradeRevision.fromJson(Map<String, Object?> json) => GradeRevision(
    id: json['id']! as String,
    status: GradeRevisionStatus.fromWire(json['status'] as String?),
    reason: json['reason']! as String,
    rejectionReason: json['rejection_reason'] as String?,
    changes: ((json['changes'] as List<Object?>?) ?? const [])
        .map(
          (e) => GradeRevisionChange.fromJson(
            Map<String, Object?>.from(e! as Map),
          ),
        )
        .toList(growable: false),
  );
}

/// One gradeable item ("assessment" cell) inside a student's submission.
class GradeCell {
  const GradeCell({
    required this.id,
    required this.submissionId,
    required this.label,
    required this.score,
    required this.maxScore,
    required this.weight,
    required this.updatedAt,
  });

  /// Grade record UUID — the `id` a `bulkUpdateGrades` entry targets.
  final String id;

  final String submissionId;

  /// Human-readable assessment name, e.g. "Midterm", "Homework 3". Cells sharing a label across
  /// students form one column on the entry screen.
  final String label;

  /// The score, or null when ungraded.
  final double? score;

  /// Maximum attainable score (> 0). A score outside `0..maxScore` is rejected inline.
  final double maxScore;

  final double weight;

  /// Opaque optimistic-concurrency token from this read. Echoed verbatim on the next write; a
  /// mismatch means someone else edited the row and the batch is rejected with 409.
  final String updatedAt;

  bool get isGraded => score != null;

  /// Whether [value] is a writable score for this cell (`0 <= value <= maxScore`).
  bool scoreInRange(double value) => value >= 0 && value <= maxScore;

  GradeCell copyWith({
    double? score,
    bool clearScore = false,
    String? updatedAt,
  }) => GradeCell(
    id: id,
    submissionId: submissionId,
    label: label,
    score: clearScore ? null : (score ?? this.score),
    maxScore: maxScore,
    weight: weight,
    updatedAt: updatedAt ?? this.updatedAt,
  );

  factory GradeCell.fromJson(Map<String, Object?> json) => GradeCell(
    id: json['id']! as String,
    submissionId: json['grade_submission_id']! as String,
    label: json['label']! as String,
    score: (json['score'] as num?)?.toDouble(),
    maxScore: (json['max_score']! as num).toDouble(),
    weight: (json['weight']! as num).toDouble(),
    updatedAt: json['updated_at']! as String,
  );
}

/// One student's row in a gradebook: their status plus every assessment cell they carry.
class GradeSubmission {
  const GradeSubmission({
    required this.id,
    required this.gradebookId,
    required this.studentId,
    required this.status,
    required this.rejectionReason,
    required this.updatedAt,
    required this.cells,
    this.latestRevision,
  });

  final String id;
  final String gradebookId;
  final String studentId;
  final GradeSubmissionStatus status;

  /// Set only when [status] is [GradeSubmissionStatus.rejected].
  final String? rejectionReason;

  /// Optimistic-concurrency token for the submission row itself — passed to `submit`.
  final String updatedAt;

  final List<GradeCell> cells;

  /// The most recent non-withdrawn correction filed against this (published) submission.
  final GradeRevision? latestRevision;

  factory GradeSubmission.fromJson(Map<String, Object?> json) =>
      GradeSubmission(
        id: json['id']! as String,
        gradebookId: json['gradebook_id']! as String,
        studentId: json['student_id']! as String,
        status: GradeSubmissionStatus.fromWire(json['status'] as String?),
        rejectionReason: json['rejection_reason'] as String?,
        updatedAt: json['updated_at']! as String,
        cells: ((json['grades'] as List<Object?>?) ?? const [])
            .map(
              (e) => GradeCell.fromJson(Map<String, Object?>.from(e! as Map)),
            )
            .toList(growable: false),
        latestRevision: json['latest_revision'] is Map
            ? GradeRevision.fromJson(
                Map<String, Object?>.from(json['latest_revision']! as Map),
              )
            : null,
      );
}

/// The gradebook a class's grade entry hangs off. Resolved (and lazily created) from a class id.
class GradebookRef {
  const GradebookRef({
    required this.id,
    required this.classId,
    required this.status,
    required this.gradingSchemeId,
  });

  final String id;
  final String classId;
  final String status;
  final String? gradingSchemeId;

  factory GradebookRef.fromJson(Map<String, Object?> json) => GradebookRef(
    id: json['id']! as String,
    classId: json['class_id']! as String,
    status: json['status']! as String,
    gradingSchemeId: json['grading_scheme_id'] as String?,
  );
}

/// One assessment column: the distinct [label] across the gradebook, with the max score and
/// weight it is entered against (assumed uniform per label — the create-assessment endpoint
/// writes the same values to every student).
class AssessmentColumn {
  const AssessmentColumn({
    required this.label,
    required this.maxScore,
    required this.weight,
  });

  final String label;
  final double maxScore;
  final double weight;
}

/// One student's editable entry for a single assessment.
class StudentGradeEntry {
  const StudentGradeEntry({
    required this.studentId,
    required this.submissionId,
    required this.status,
    required this.rejectionReason,
    required this.cell,
    this.submissionUpdatedAt = '',
    this.latestRevision,
  });

  final String studentId;
  final String submissionId;
  final GradeSubmissionStatus status;
  final String? rejectionReason;
  final GradeCell cell;

  /// The submission row's concurrency token — what `unlock` needs.
  final String submissionUpdatedAt;
  final GradeRevision? latestRevision;

  bool get isEditable => status.isEditable;

  /// A correction to this published grade is waiting for approval.
  bool get hasPendingRevision => latestRevision?.isPending ?? false;
}

/// A read-model over the gradebook's submissions, sliced for a per-assessment entry screen.
class GradeEntryGrid {
  const GradeEntryGrid(this.submissions);

  final List<GradeSubmission> submissions;

  bool get isEmpty => submissions.isEmpty;

  int get studentCount => submissions.length;

  /// Distinct assessments across the gradebook, sorted by label.
  List<AssessmentColumn> get assessments {
    final byLabel = <String, AssessmentColumn>{};
    for (final submission in submissions) {
      for (final cell in submission.cells) {
        byLabel.putIfAbsent(
          cell.label,
          () => AssessmentColumn(
            label: cell.label,
            maxScore: cell.maxScore,
            weight: cell.weight,
          ),
        );
      }
    }
    final list = byLabel.values.toList();
    list.sort((a, b) => a.label.toLowerCase().compareTo(b.label.toLowerCase()));
    return list;
  }

  /// The per-student entry rows for one assessment [label], ordered by student id so the list is
  /// stable across refreshes.
  List<StudentGradeEntry> rowsFor(String label) {
    final rows = <StudentGradeEntry>[];
    for (final submission in submissions) {
      for (final cell in submission.cells) {
        if (cell.label != label) continue;
        rows.add(
          StudentGradeEntry(
            studentId: submission.studentId,
            submissionId: submission.id,
            status: submission.status,
            rejectionReason: submission.rejectionReason,
            cell: cell,
            submissionUpdatedAt: submission.updatedAt,
            latestRevision: submission.latestRevision,
          ),
        );
      }
    }
    rows.sort((a, b) => a.studentId.compareTo(b.studentId));
    return rows;
  }

  /// Draft submissions carrying at least one graded cell — the ones "Submit for approval" acts
  /// on. Returned newest-student-id-first order is irrelevant; the screen only needs the count
  /// and the id/token pairs.
  List<GradeSubmission> get submittableSubmissions => submissions
      .where((s) => s.status.isEditable && s.cells.any((c) => c.isGraded))
      .toList(growable: false);
}
