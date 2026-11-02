/// One term's point on the grades trend sparkline: the term's name and its published term
/// average / GPA. Mirrors the API's own `GradeTrendPoint` schema
/// (`apps/api/src/modules/reports`), which the parent comparison screens return but the student
/// published-grades endpoint does not — the student screen assembles the trend itself from each
/// term's snapshot summary (see `grade_providers.dart`).
class GradeTrendPoint {
  const GradeTrendPoint({
    required this.termId,
    required this.termName,
    required this.termSequenceNumber,
    required this.termAveragePercentage,
    required this.termGpa,
  });

  final String termId;
  final String termName;
  final int termSequenceNumber;

  /// The published term average, 0–100, or null when the term has no materialised summary yet.
  final double? termAveragePercentage;

  /// The published term GPA, or null when the term has no complete GPA (or no summary yet).
  final double? termGpa;
}
