import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/tokens/app_radius_tokens.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../domain/ai_usage.dart';

/// The subscribed hub's quota meter: a progress bar over remaining budget, plus when the period
/// resets. Token counts are an implementation detail of the monthly budget (see
/// `AiUsage.usedFraction`'s doc comment) — shown in [AiUsage.remaining]/[AiUsage.budget] terms
/// students already think in ("how much do I have left"), not raw token math.
///
/// [onTap], when set, makes the whole card a link (with a trailing chevron) to `AiUsageScreen` --
/// the same [usage] snapshot's full detail plus the nearing-limit warning this compact card has no
/// room for. Left `null` where the card *is* already that detail (inside `AiUsageScreen` itself).
class AiUsageMeter extends StatelessWidget {
  const AiUsageMeter({required this.usage, this.onTap, super.key});

  final AiUsage usage;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;

    return Material(
      color: colorScheme.surfaceContainerHighest,
      borderRadius: AppRadius.lgRadius,
      child: InkWell(
        onTap: onTap,
        borderRadius: AppRadius.lgRadius,
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.space16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(child: Text('ai.hub.usage.title'.tr(), style: textTheme.titleSmall)),
                  if (onTap != null)
                    Icon(Icons.chevron_right, size: 20, color: colorScheme.onSurfaceVariant),
                ],
              ),
              const SizedBox(height: AppSpacing.space8),
              ClipRRect(
                borderRadius: AppRadius.smRadius,
                child: LinearProgressIndicator(
                  value: usage.usedFraction,
                  minHeight: 8,
                  backgroundColor: colorScheme.surfaceContainerHigh,
                ),
              ),
              const SizedBox(height: AppSpacing.space8),
              Text(
                'ai.hub.usage.remaining'.tr(
                  namedArgs: {
                    'remaining': usage.remaining.toString(),
                    'budget': usage.budget.toString(),
                  },
                ),
                style: textTheme.bodySmall?.copyWith(color: colorScheme.onSurfaceVariant),
              ),
              Text(
                'ai.hub.usage.resets'.tr(
                  namedArgs: {
                    'date': DateFormat.yMMMd(context.locale.toString()).format(usage.periodEnd),
                  },
                ),
                style: textTheme.bodySmall?.copyWith(color: colorScheme.onSurfaceVariant),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
