import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/kit/kit.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../domain/academic_plans.dart';
import 'mark_sheet_common.dart';

/// Shared pieces of the outcome achievement and plan screens (000267).

/// A plan's review status as a pill; an unknown status reads neutrally.
class PlanStatusPill extends StatelessWidget {
  const PlanStatusPill({required this.status, super.key});

  final PlanStatus status;

  @override
  Widget build(BuildContext context) {
    final (key, tone) = switch (status) {
      PlanStatus.draft => ('draft', AppTone.neutral),
      PlanStatus.submitted => ('submitted', AppTone.info),
      PlanStatus.approved => ('approved', AppTone.success),
      PlanStatus.returned => ('returned', AppTone.warning),
      PlanStatus.unknown => ('unknown', AppTone.neutral),
    };
    return AppStatusPill(label: 'teacher.plans.status.$key'.tr(), tone: tone);
  }
}

/// A plan failure in the teacher's words.
String planErrorMessage(Object error) => switch (markErrorCode(error)) {
  'CONFLICT_STATE_MISMATCH' => 'teacher.plans.errors.state'.tr(),
  'CONFLICT_DUPLICATE_ENTRY' => 'teacher.plans.errors.duplicate'.tr(),
  'VALIDATION_FAILED' => 'teacher.plans.errors.invalid'.tr(),
  'AUTHZ_FORBIDDEN' => 'teacher.plans.errors.forbidden'.tr(),
  'RESULTS_ALREADY_FINALIZED' => 'teacher.outcomes.finalized'.tr(),
  _ => markErrorMessage(error),
};

String formatPlanDate(BuildContext context, DateTime date) =>
    DateFormat.yMMMEd(context.locale.toString()).format(date);

/// The outcomes a plan covers, picked from [available] by tapping their codes. Outcomes already
/// chosen but no longer offered (archived) stay chosen and visible.
class OutcomePicker extends StatelessWidget {
  const OutcomePicker({
    required this.available,
    required this.selected,
    required this.onChanged,
    this.enabled = true,
    super.key,
  });

  final List<OutcomeRef> available;
  final List<OutcomeRef> selected;
  final ValueChanged<List<OutcomeRef>> onChanged;
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    final language = context.locale.languageCode;
    final chosen = {for (final outcome in selected) outcome.id};
    final all = [
      ...available,
      for (final outcome in selected)
        if (!available.any((candidate) => candidate.id == outcome.id)) outcome,
    ];
    if (all.isEmpty) {
      return Text(
        'teacher.plans.noOutcomes'.tr(),
        style: Theme.of(context).textTheme.bodySmall,
      );
    }
    return Wrap(
      spacing: AppSpacing.space8,
      runSpacing: AppSpacing.space4,
      children: [
        for (final outcome in all)
          Tooltip(
            message: outcome.textFor(language),
            child: FilterChip(
              label: Text(outcome.code),
              selected: chosen.contains(outcome.id),
              onSelected: enabled
                  ? (on) => onChanged(
                      on
                          ? [...selected, outcome]
                          : selected
                                .where((other) => other.id != outcome.id)
                                .toList(),
                    )
                  : null,
            ),
          ),
      ],
    );
  }
}

/// The outcomes as a readable list: code and text in the app's language.
class OutcomeList extends StatelessWidget {
  const OutcomeList({required this.outcomes, super.key});

  final List<OutcomeRef> outcomes;

  @override
  Widget build(BuildContext context) {
    final language = context.locale.languageCode;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final outcome in outcomes)
          Padding(
            padding: const EdgeInsets.only(bottom: AppSpacing.space4),
            child: Text('${outcome.code} · ${outcome.textFor(language)}'),
          ),
      ],
    );
  }
}

/// The reviewer's comment on a returned (or reviewed) plan.
class ReviewCommentBanner extends StatelessWidget {
  const ReviewCommentBanner({required this.header, super.key});

  final PlanHeader header;

  @override
  Widget build(BuildContext context) {
    final comment = header.reviewComment;
    if (comment == null) return const SizedBox.shrink();
    final theme = Theme.of(context);
    return Card(
      margin: const EdgeInsets.only(bottom: AppSpacing.space12),
      color: AppTone.warning.colorsOf(context).container,
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              header.reviewedByName == null
                  ? 'teacher.plans.reviewComment'.tr()
                  : 'teacher.plans.reviewCommentBy'.tr(
                      namedArgs: {'name': header.reviewedByName!},
                    ),
              style: theme.textTheme.labelLarge,
            ),
            const SizedBox(height: AppSpacing.space4),
            Text(comment, style: theme.textTheme.bodyMedium),
          ],
        ),
      ),
    );
  }
}

/// A labelled block of a plan's text, hidden when empty.
class PlanTextBlock extends StatelessWidget {
  const PlanTextBlock({required this.labelKey, required this.value, super.key});

  final String labelKey;
  final String? value;

  @override
  Widget build(BuildContext context) {
    final text = value;
    if (text == null || text.trim().isEmpty) return const SizedBox.shrink();
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.space12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(labelKey.tr(), style: theme.textTheme.labelLarge),
          const SizedBox(height: AppSpacing.space4),
          Text(text, style: theme.textTheme.bodyMedium),
        ],
      ),
    );
  }
}
