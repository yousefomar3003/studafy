import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/features/feature_gate.dart';
import '../../../../core/features/features_providers.dart';
import '../../../../core/features/my_features.dart';
import '../../../../design/tokens/app_color_tokens.dart';
import '../../../../design/tokens/app_radius_tokens.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../../shell/application/shell_providers.dart';

/// The AI Study Assistant offer, drawn inside the blue `TodayDateHero` under the date (its
/// `footer`), for a student who could buy it in the app.
///
/// Shown only in [FeaturePurchasable]: a student already covered (personally or by a school seat)
/// has the AI tab itself, and one the school would cover is never sold to in the app (App Store /
/// Google Play rules; see `FeatureGateState`). Nothing renders while the verdict is loading or
/// unknown, which leaves the hero exactly as it is for everyone else. A tap opens the AI tab, whose
/// paywall carries the store's own price and purchase — this offer names no price.
class TodayAiPromo extends ConsumerWidget {
  const TodayAiPromo({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final gate = ref.watch(featureGateProvider(FeatureKeys.aiTutor)).value;
    if (gate is! FeaturePurchasable) return const SizedBox.shrink();

    final textTheme = Theme.of(context).textTheme;
    void openAi() => ref.read(selectedShellTabProvider.notifier).select('shell.tabs.ai');

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: AppSpacing.space20),
        Divider(height: 1, thickness: 1, color: AppColorTokens.white.withValues(alpha: 0.2)),
        const SizedBox(height: AppSpacing.space16),
        Material(
          type: MaterialType.transparency,
          child: InkWell(
            onTap: openAi,
            borderRadius: AppRadius.mdRadius,
            child: Row(
              children: [
                DecoratedBox(
                  decoration: BoxDecoration(
                    color: AppColorTokens.white.withValues(alpha: 0.16),
                    borderRadius: AppRadius.mdRadius,
                  ),
                  child: const Padding(
                    padding: EdgeInsets.all(AppSpacing.space8),
                    child: Icon(Icons.auto_awesome_outlined, size: 18, color: AppColorTokens.white),
                  ),
                ),
                const SizedBox(width: AppSpacing.space12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'today.aiPromo.title'.tr(),
                        style: textTheme.titleSmall?.copyWith(
                          color: AppColorTokens.white,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        'today.aiPromo.body'.tr(),
                        style: textTheme.bodySmall?.copyWith(
                          color: AppColorTokens.white.withValues(alpha: 0.8),
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: AppSpacing.space12),
                FilledButton(
                  onPressed: openAi,
                  style: FilledButton.styleFrom(
                    backgroundColor: AppColorTokens.white,
                    foregroundColor: AppColorTokens.accent600,
                    visualDensity: VisualDensity.compact,
                    padding: const EdgeInsets.symmetric(horizontal: AppSpacing.space16),
                    textStyle: textTheme.labelLarge?.copyWith(fontWeight: FontWeight.w600),
                  ),
                  child: Text('today.aiPromo.action'.tr()),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}
