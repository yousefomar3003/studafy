import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../core/config/legal_links.dart';
import '../../../core/di/app_providers.dart';
import '../../../design/tokens/app_radius_tokens.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import 'ai_store_backend.dart';
import 'ai_store_controller.dart';
import 'store_gateway.dart';

/// Buying the AI add-on through the App Store / Google Play, under the not-active notice.
///
/// What the stores require of a subscription purchase screen, and nothing else: the store's own
/// localized price and period, a way to restore purchases, how renewal and cancelling work, and
/// links to the privacy policy and (App Store) terms of use. Never a price of its own, and never a
/// way to pay outside the store (`apps/mobile/docs/store_payment_routing.md`). Renders nothing
/// while loading or when [AiStoreHidden].
class AiStoreOfferCard extends ConsumerWidget {
  const AiStoreOfferCard({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(aiStoreProvider).value;
    return switch (state) {
      AiStoreOffering() => _Offer(offer: state),
      AiStoreActivated() => const Padding(
        padding: EdgeInsets.all(AppSpacing.space16),
        child: Center(child: CircularProgressIndicator()),
      ),
      AiStoreHidden() || null => const SizedBox.shrink(),
    };
  }
}

class _Offer extends ConsumerWidget {
  const _Offer({required this.offer});

  final AiStoreOffering offer;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final colorScheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    final controller = ref.read(aiStoreProvider.notifier);
    final busy = offer.busy != AiStoreBusy.none;
    final apple = currentStorePlatform() == StorePlatform.apple;

    return Container(
      margin: const EdgeInsets.only(top: AppSpacing.space16),
      padding: const EdgeInsets.all(AppSpacing.space20),
      decoration: BoxDecoration(
        border: Border.all(color: colorScheme.outlineVariant),
        borderRadius: AppRadius.lgRadius,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text('aiStore.title'.tr(), style: textTheme.titleMedium),
          const SizedBox(height: AppSpacing.space4),
          Text(
            'aiStore.price'.tr(namedArgs: {'price': offer.price}),
            style: textTheme.headlineSmall,
          ),
          const SizedBox(height: AppSpacing.space16),
          FilledButton(
            onPressed: busy ? null : controller.buy,
            child: offer.busy == AiStoreBusy.purchasing
                ? const SizedBox.square(
                    dimension: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : Text('aiStore.subscribe'.tr()),
          ),
          TextButton(
            onPressed: busy ? null : controller.restore,
            child: offer.busy == AiStoreBusy.restoring
                ? const SizedBox.square(
                    dimension: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : Text('aiStore.restore.action'.tr()),
          ),
          if (offer.messageKey case final key?) ...[
            const SizedBox(height: AppSpacing.space8),
            Text(
              key.tr(),
              key: const ValueKey('aiStore.message'),
              style: textTheme.bodySmall?.copyWith(color: colorScheme.error),
              textAlign: TextAlign.center,
            ),
          ],
          const SizedBox(height: AppSpacing.space12),
          Text(
            (apple ? 'aiStore.renewal.apple' : 'aiStore.renewal.google').tr(),
            style: textTheme.bodySmall?.copyWith(color: colorScheme.onSurfaceVariant),
            textAlign: TextAlign.center,
          ),
          Wrap(
            alignment: WrapAlignment.center,
            children: [
              TextButton(
                onPressed: () => launchUrl(
                  ref.read(privacyPolicyUrlProvider),
                  mode: LaunchMode.externalApplication,
                ),
                child: Text('aiStore.links.privacy'.tr()),
              ),
              if (apple)
                TextButton(
                  onPressed: () =>
                      launchUrl(appleStandardEulaUrl, mode: LaunchMode.externalApplication),
                  child: Text('aiStore.links.terms'.tr()),
                ),
            ],
          ),
        ],
      ),
    );
  }
}
