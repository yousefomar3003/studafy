import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/api/generated/models/term.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../../student/application/grade_providers.dart' show academicYearTermsProvider;
import '../../../student/domain/grade_report.dart' show defaultGradeTerm;
import '../../application/comparison_providers.dart';

/// The term picker above the comparison charts: one chip per term of the academic year, the
/// selected one filled. Mirrors the student grades screen's `GradeTermSelector` — hidden below
/// two terms, since there is nothing to pick with only one.
class ComparisonTermSelector extends ConsumerWidget {
  const ComparisonTermSelector({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final terms = ref.watch(academicYearTermsProvider).value;
    if (terms == null || terms.length < 2) return const SizedBox.shrink();

    final selectedId = _resolveSelectedId(terms, ref.watch(selectedComparisonTermProvider));

    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Row(
        children: [
          for (final term in terms)
            Padding(
              padding: const EdgeInsetsDirectional.only(end: AppSpacing.space8),
              child: ChoiceChip(
                label: Text(term.name),
                selected: term.id == selectedId,
                onSelected: (_) =>
                    ref.read(selectedComparisonTermProvider.notifier).select(term.id),
              ),
            ),
        ],
      ),
    );
  }

  String _resolveSelectedId(List<Term> terms, String? selectedId) {
    if (selectedId != null && terms.any((term) => term.id == selectedId)) {
      return selectedId;
    }
    return defaultGradeTerm(terms).id;
  }
}
