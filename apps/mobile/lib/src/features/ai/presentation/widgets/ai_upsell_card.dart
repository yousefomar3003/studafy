import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../../design/tokens/app_radius_tokens.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/ai_hub_providers.dart';

/// The unsubscribed state: a value explainer (no pricing — see
/// `apps/mobile/docs/ai_store_compliance.md`, R-07) and a single "Continue on the website"
/// action. There is no purchase control here or anywhere in this app; tapping it only opens the
/// system browser to the website's own checkout page — see `buildAiCheckoutUrl`
/// (`../../domain/ai_checkout_link.dart`) for the destination and why it's disabled instead of
/// launching a broken link when the checkout URL can't be built yet.
class AiUpsellCard extends ConsumerWidget {
  const AiUpsellCard({super.key});

  static const _valuePointKeys = [
    'ai.upsell.points.ask',
    'ai.upsell.points.quizzesAndFlashcards',
    'ai.upsell.points.summaries',
  ];

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final colorScheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    final checkoutUrl = ref.watch(aiCheckoutUrlProvider);

    return Container(
      padding: const EdgeInsets.all(AppSpacing.space20),
      decoration: BoxDecoration(
        color: colorScheme.primaryContainer,
        borderRadius: AppRadius.lgRadius,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'ai.upsell.title'.tr(),
            style: textTheme.titleLarge?.copyWith(color: colorScheme.onPrimaryContainer),
          ),
          const SizedBox(height: AppSpacing.space8),
          Text(
            'ai.upsell.body'.tr(),
            style: textTheme.bodyMedium?.copyWith(color: colorScheme.onPrimaryContainer),
          ),
          const SizedBox(height: AppSpacing.space16),
          for (final pointKey in _valuePointKeys) ...[
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(Icons.check_circle_outline, size: 18, color: colorScheme.onPrimaryContainer),
                const SizedBox(width: AppSpacing.space8),
                Expanded(
                  child: Text(
                    pointKey.tr(),
                    style: textTheme.bodyMedium?.copyWith(color: colorScheme.onPrimaryContainer),
                  ),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.space8),
          ],
          const SizedBox(height: AppSpacing.space8),
          FilledButton.icon(
            onPressed: checkoutUrl == null
                ? null
                : () => launchUrl(checkoutUrl, mode: LaunchMode.externalApplication),
            icon: const Icon(Icons.open_in_new),
            label: Text('ai.upsell.continueOnWebsite'.tr()),
          ),
          if (checkoutUrl == null) ...[
            const SizedBox(height: AppSpacing.space8),
            Text(
              'ai.upsell.continueUnavailable'.tr(),
              style: textTheme.bodySmall?.copyWith(color: colorScheme.onPrimaryContainer),
            ),
          ],
        ],
      ),
    );
  }
}
