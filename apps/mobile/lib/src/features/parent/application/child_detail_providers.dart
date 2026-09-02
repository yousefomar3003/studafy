import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/generated/models/child_comparison_breakdown.dart';
import '../../../core/auth/auth_providers.dart';
// `currentTermProvider` is school-scoped context (active year + term), not student-specific — the
// same call the parent home already makes for the comparison report. See
// [[mobile_parent_home_st239]] for why it still lives in the student feature.
import '../../student/application/current_term_provider.dart';

/// One linked child's full academic breakdown for the current term: identity, per-course
/// published grades with the term summary, grade trend, attendance totals + weekly trend, and
/// assignment completion.
///
/// This is the single data source behind every tab of `ChildDetailScreen`. The endpoint
/// (`GET /api/reports/children/{studentId}/breakdown`) is parent-only and RLS-scoped to the
/// caller's `app.parent_child_links` rows, so "scope enforced" is the endpoint's own guarantee —
/// a request for an unlinked child answers 403 and surfaces here as an [AsyncError].
///
/// Keyed by `studentId` so switching child in the switcher re-scopes the whole screen to a fresh
/// fetch rather than reusing the previous child's data.
final childBreakdownProvider = FutureProvider.autoDispose
    .family<ChildComparisonBreakdown, String>((ref, studentId) async {
      final term = await ref.watch(currentTermProvider.future);
      return ref
          .watch(apiClientProvider)
          .childComparisonReports
          .getChildComparisonBreakdown(studentId: studentId, termId: term.id);
    });
