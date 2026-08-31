import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../design/tokens/app_radius_tokens.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/ai_study_providers.dart';

/// A thin footer showing how much of the month's AI token budget is spent, from
/// [aiUsageProvider]. Informational only: while the quota loads or if the read fails it collapses
/// to nothing rather than blocking the screen it sits under.
class AiQuotaMeter extends ConsumerWidget {
  const AiQuotaMeter({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final colorScheme = Theme.of(context).colorScheme;

    return ref
        .watch(aiUsageProvider)
        .maybeWhen(
          orElse: () => const SizedBox.shrink(),
          data: (usage) {
            if (!usage.hasBudget) return const SizedBox.shrink();
            final spent = usage.usedTokens + usage.heldTokens;

            return Material(
              color: colorScheme.surfaceContainerHighest,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(
                  AppSpacing.space16,
                  AppSpacing.space8,
                  AppSpacing.space16,
                  AppSpacing.space12,
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Row(
                      children: [
                        Icon(
                          Icons.bolt_outlined,
                          size: 16,
                          color: colorScheme.onSurfaceVariant,
                        ),
                        const SizedBox(width: AppSpacing.space8),
                        Text(
                          'aiStudy.quota.label'.tr(
                            namedArgs: {
                              'used': _grouped(spent),
                              'budget': _grouped(usage.budget),
                            },
                          ),
                          style: Theme.of(context).textTheme.labelMedium?.copyWith(
                            color: colorScheme.onSurfaceVariant,
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: AppSpacing.space4),
                    ClipRRect(
                      borderRadius: AppRadius.smRadius,
                      child: LinearProgressIndicator(
                        value: usage.fraction,
                        minHeight: 6,
                        backgroundColor: colorScheme.surfaceContainerHighest,
                      ),
                    ),
                  ],
                ),
              ),
            );
          },
        );
  }

  /// `1234567` -> `1,234,567`. A local helper — the app has no shared number formatter and the
  /// meter is the only place that needs one.
  static String _grouped(int value) {
    final digits = value.toString();
    final buffer = StringBuffer();
    for (var i = 0; i < digits.length; i++) {
      if (i > 0 && (digits.length - i) % 3 == 0) buffer.write(',');
      buffer.write(digits[i]);
    }
    return buffer.toString();
  }
}
