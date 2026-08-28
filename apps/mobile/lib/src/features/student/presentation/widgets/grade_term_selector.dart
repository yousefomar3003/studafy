import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/api/generated/models/term.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/grade_providers.dart';
import '../../domain/grade_report.dart';

/// The term picker above the grades report: one chip per term of the academic year, the
/// selected one filled. Sits directly under the app bar, above the scrolling report, the same
/// way `TimetableWeekNavigator` does for the timetable.
///
/// Owns its own reads of [academicYearTermsProvider] and [selectedGradeTermProvider] rather
/// than taking them from the parent, so it is the single place that renders term choices.
/// Hidden when the year has fewer than two terms — there is nothing to pick.
class GradeTermSelector extends ConsumerWidget {
  const GradeTermSelector({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final terms = ref.watch(academicYearTermsProvider).valueOrNull;
    if (terms == null || terms.length < 2) return const SizedBox.shrink();

    final selectedId = _resolveSelectedId(terms, ref.watch(selectedGradeTermProvider));

    return DecoratedBox(
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: theme.colorScheme.outlineVariant)),
      ),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.space16,
          vertical: AppSpacing.space8,
        ),
        child: Row(
          children: [
            for (final term in terms)
              Padding(
                padding: const EdgeInsetsDirectional.only(end: AppSpacing.space8),
                child: ChoiceChip(
                  label: Text(term.name),
                  selected: term.id == selectedId,
                  onSelected: (_) =>
                      ref.read(selectedGradeTermProvider.notifier).select(term.id),
                ),
              ),
          ],
        ),
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
