import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/remedial_plans_providers.dart';
import '../../domain/remedial_plan.dart';
import '../remedial_plan_detail_screen.dart';
import 'remedial_plan_widgets.dart';

/// The "Support plans" block of the student's and parent's results screen (000268): the remedial
/// plans the school has shared with the family, each opening its targets, reviews and progress.
/// Read-only. Takes no space unless a plan is shared — including while loading and on an error,
/// since most students never have one.
class RemedialPlansSection extends ConsumerWidget {
  const RemedialPlansSection({required this.studentId, super.key});

  final String studentId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final plans =
        ref.watch(studentRemedialPlansProvider(studentId)).value ??
        const <RemedialPlan>[];
    if (plans.isEmpty) return const SizedBox.shrink();
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text('remedial.family.title'.tr(), style: theme.textTheme.titleMedium),
        const SizedBox(height: AppSpacing.space4),
        Text(
          'remedial.family.help'.tr(),
          style: theme.textTheme.bodySmall?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: AppSpacing.space8),
        for (final plan in plans)
          RemedialPlanCard(
            plan: plan.summary,
            showStudent: false,
            onTap: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => RemedialPlanDetailScreen(planId: plan.id),
              ),
            ),
          ),
        const SizedBox(height: AppSpacing.space8),
      ],
    );
  }
}
