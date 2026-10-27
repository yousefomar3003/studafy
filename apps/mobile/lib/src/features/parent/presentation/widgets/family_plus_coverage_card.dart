import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/features/feature_gate.dart';
import '../../../../core/features/features_providers.dart';
import '../../../../core/features/my_features.dart';
import '../../../../design/tokens/app_radius_tokens.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/parent_providers.dart';

/// Which of the parent's children Family+ covers, and through whom
/// (`docs/billing/feature-licensing.md`, session 6).
///
/// A school's Family+ seat covers the parent for their children **at that school only**: accounts,
/// children and seats are per school, so this session sees this school's children, and the card
/// names them and says plainly that children at other schools need the personal Family+ (or a seat
/// from their own school). A personal Family+ covers every child. Nothing is sold here: Family+ has
/// no store product in the app, so an uncovered parent is told what exists, not offered a purchase.
class FamilyPlusCoverageCard extends ConsumerWidget {
  const FamilyPlusCoverageCard({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final gate = ref.watch(featureGateProvider(FeatureKeys.familyPlus)).value;
    if (gate == null || gate is FeatureUnavailable) {
      return const SizedBox.shrink();
    }
    final children = ref.watch(linkedChildrenProvider).value ?? const [];
    final names = children.map((child) => child.studentName).join(', ');
    final date = DateFormat.yMMMd(context.locale.toString());

    final lines = switch (gate) {
      FeatureCovered(coverage: FeatureCoverage.personal) => [
        'familyPlus.personal'.tr(),
      ],
      FeatureCovered(
        :final schoolName,
        :final coverage,
        :final personalEndsAt,
      ) =>
        [
          names.isEmpty
              ? 'familyPlus.school'.tr(namedArgs: {'school': schoolName})
              : 'familyPlus.schoolChildren'.tr(
                  namedArgs: {'school': schoolName, 'children': names},
                ),
          'familyPlus.otherSchools'.tr(namedArgs: {'school': schoolName}),
          if (coverage == FeatureCoverage.both)
            personalEndsAt != null
                ? 'features.covered.bothRenewal'.tr(
                    namedArgs: {'date': date.format(personalEndsAt.toLocal())},
                  )
                : 'features.covered.bothRenewalNoDate'.tr(),
          if (gate.mustTurnOffAppStoreRenewal)
            'features.covered.appStoreSteps'.tr(),
        ],
      FeatureAskSchool(:final schoolName) => [
        'familyPlus.askSchool'.tr(namedArgs: {'school': schoolName}),
      ],
      FeatureSchoolInactive() => ['features.schoolInactive.body'.tr()],
      FeaturePurchasable() => ['familyPlus.notCovered'.tr()],
      FeatureUnavailable() => const <String>[],
    };

    final colorScheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    return Container(
      padding: const EdgeInsets.all(AppSpacing.space16),
      decoration: BoxDecoration(
        color: colorScheme.surfaceContainerHighest,
        borderRadius: AppRadius.lgRadius,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('familyPlus.title'.tr(), style: textTheme.titleMedium),
          for (final line in lines) ...[
            const SizedBox(height: AppSpacing.space8),
            Text(line, style: textTheme.bodyMedium),
          ],
        ],
      ),
    );
  }
}
