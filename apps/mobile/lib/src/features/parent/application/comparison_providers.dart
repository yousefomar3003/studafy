import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/generated/models/child_comparison_report.dart';
import '../../../core/api/generated/models/term.dart';
import '../../../core/auth/auth_providers.dart';
// `academicYearTermsProvider` and `defaultGradeTerm` are school-scoped / pure helpers, not
// student-specific — the parent feature already reuses their neighbour `currentTermProvider`
// (see `parent_providers.dart`) for the same reason. Imported directly rather than duplicated;
// this is now the second parent-feature import from here, a further cue to promote all three to
// a shared `core/academics/` location.
import '../../student/application/grade_providers.dart' show academicYearTermsProvider;
import '../../student/domain/grade_report.dart' show defaultGradeTerm;

/// Which term the comparison screen shows. Null means "follow the default" — the active term of
/// the current academic year, resolved against [academicYearTermsProvider] the same way
/// `selectedGradeTermProvider` resolves the student grades screen's term. App-scoped (not
/// `autoDispose`) so a pick survives leaving and returning to the screen.
class SelectedComparisonTermNotifier extends Notifier<String?> {
  @override
  String? build() => null;

  void select(String termId) => state = termId;
}

final selectedComparisonTermProvider =
    NotifierProvider<SelectedComparisonTermNotifier, String?>(
  SelectedComparisonTermNotifier.new,
);

/// The child-comparison report for [selectedComparisonTermProvider] (or the default term when
/// nothing has been picked yet): every linked child's grade snapshot and trend, attendance
/// totals, and assignment completion, all scoped to that one term.
///
/// `autoDispose`, unlike the parent home's `childComparisonProvider`: this is scoped to whichever
/// term the comparison screen is currently showing, nothing else depends on it, and there is no
/// reason to keep a stale term's report alive once the screen closes.
final comparisonReportProvider = FutureProvider.autoDispose<ChildComparisonReport>((ref) async {
  final terms = await ref.watch(academicYearTermsProvider.future);
  if (terms.isEmpty) {
    throw StateError('No academic terms to compare.');
  }
  final term = _resolveSelectedTerm(terms, ref.watch(selectedComparisonTermProvider));
  return ref
      .watch(apiClientProvider)
      .childComparisonReports
      .getChildrenComparison(termId: term.id);
});

Term _resolveSelectedTerm(List<Term> terms, String? selectedId) {
  if (selectedId != null) {
    for (final term in terms) {
      if (term.id == selectedId) return term;
    }
  }
  return defaultGradeTerm(terms);
}
