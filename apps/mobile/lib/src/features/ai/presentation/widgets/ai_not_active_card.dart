import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/tokens/app_radius_tokens.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';

/// The unsubscribed state: says the AI add-on isn't active for this account and what it includes,
/// and nothing else. The add-on is a digital subscription sold on the web only, and both stores
/// forbid a native app from linking or otherwise steering to a purchase outside their own in-app
/// purchase — so there is deliberately no button, link, price or "get it on the website" copy here
/// (ST-304; see `apps/mobile/docs/store_payment_routing.md`, pinned by
/// `test/store_compliance/payment_routing_test.dart`). An add-on activated elsewhere shows up on
/// the next resume or pull-to-refresh (`AiHubScreen`).
class AiNotActiveCard extends StatelessWidget {
  const AiNotActiveCard({super.key});

  static const _includedKeys = [
    'ai.notActive.points.ask',
    'ai.notActive.points.quizzesAndFlashcards',
    'ai.notActive.points.summaries',
  ];

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;

    return Container(
      padding: const EdgeInsets.all(AppSpacing.space20),
      decoration: BoxDecoration(
        color: colorScheme.surfaceContainerHighest,
        borderRadius: AppRadius.lgRadius,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('ai.notActive.title'.tr(), style: textTheme.titleLarge),
          const SizedBox(height: AppSpacing.space8),
          Text('ai.notActive.body'.tr(), style: textTheme.bodyMedium),
          const SizedBox(height: AppSpacing.space16),
          for (final key in _includedKeys) ...[
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(Icons.check_circle_outline, size: 18, color: colorScheme.onSurfaceVariant),
                const SizedBox(width: AppSpacing.space8),
                Expanded(child: Text(key.tr(), style: textTheme.bodyMedium)),
              ],
            ),
            const SizedBox(height: AppSpacing.space8),
          ],
        ],
      ),
    );
  }
}
