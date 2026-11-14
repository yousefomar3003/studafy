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

/// Buying the AI add-on through the App Store / Google Play: under the not-active notice in the
/// student's AI tab, or — with [studentId] — for one of a parent's children in the parent app.
///
/// What the stores require of a subscription purchase screen: the store's own localized price and
/// period, a way to restore purchases, how renewal and cancelling work, and links to the privacy
/// policy and (App Store) terms of use. Never a price of its own, and never a way to pay outside the
/// store (`apps/mobile/docs/store_payment_routing.md`). Renders nothing while loading or when
/// [AiStoreHidden]; says why when it cannot be bought ([AiStoreUnavailable]).
///
/// And what EU consumer law requires before a digital service starts within the 14-day withdrawal
/// period (Directive 2011/83/EU art. 16(m); Terms of Service 7.7): a required checkbox, unticked by
/// default, by which the buyer asks for it to start now and acknowledges losing the right to
/// cancel once it does, with a link to the Terms of Service. Subscribe stays disabled until it is
/// ticked; the acknowledgement is sent with the purchase and confirmed by email or in the app.
///
/// "Restore purchases" is a small link at the foot of the offer (the stores require one), and asks
/// before it runs: restoring is rarely needed, and a stray tap should not start it.
class AiStoreOfferCard extends ConsumerWidget {
  const AiStoreOfferCard({this.studentId, super.key});

  /// A parent's child to buy for; null for the signed-in student.
  final String? studentId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(aiStoreProvider(studentId)).value;
    return switch (state) {
      AiStoreOffering() => _Offer(offer: state, studentId: studentId),
      AiStoreActivated(:final name) => _Note(
        icon: Icons.check_circle_outline,
        text: name == null
            ? 'aiStore.activated'.tr()
            : 'aiStore.activatedFor'.tr(namedArgs: {'name': name}),
      ),
      AiStoreSubscribed(:final name) => _Note(
        icon: Icons.check_circle_outline,
        text: name == null
            ? 'aiStore.activated'.tr()
            : 'aiStore.activatedFor'.tr(namedArgs: {'name': name}),
      ),
      AiStoreUnavailable(:final messageKey, :final name) => _Note(
        key: const ValueKey('aiStore.unavailable'),
        icon: Icons.info_outline,
        text: messageKey.tr(namedArgs: {'name': name ?? 'aiStore.thisStudent'.tr()}),
      ),
      AiStoreHidden() || null => const SizedBox.shrink(),
    };
  }
}

class _Note extends StatelessWidget {
  const _Note({required this.icon, required this.text, super.key});

  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    return Container(
      margin: const EdgeInsets.only(top: AppSpacing.space16),
      padding: const EdgeInsets.all(AppSpacing.space16),
      decoration: BoxDecoration(
        border: Border.all(color: colorScheme.outlineVariant),
        borderRadius: AppRadius.lgRadius,
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, color: colorScheme.primary, size: 20),
          const SizedBox(width: AppSpacing.space12),
          Expanded(child: Text(text, style: Theme.of(context).textTheme.bodyMedium)),
        ],
      ),
    );
  }
}

class _Offer extends ConsumerWidget {
  const _Offer({required this.offer, required this.studentId});

  final AiStoreOffering offer;
  final String? studentId;

  Future<void> _confirmRestore(BuildContext context, AiStoreController controller) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('aiStore.restore.confirmTitle'.tr()),
        content: Text('aiStore.restore.confirmBody'.tr()),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: Text('aiStore.restore.cancel'.tr()),
          ),
          FilledButton(
            key: const ValueKey('aiStore.restore.confirm'),
            onPressed: () => Navigator.of(context).pop(true),
            child: Text('aiStore.restore.confirm'.tr()),
          ),
        ],
      ),
    );
    if (confirmed ?? false) await controller.restore();
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final colorScheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    final controller = ref.read(aiStoreProvider(studentId).notifier);
    final busy = offer.busy != AiStoreBusy.none;
    final apple = currentStorePlatform() == StorePlatform.apple;
    final name = offer.name;

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
          Text(
            studentId != null && name != null
                ? 'aiStore.titleFor'.tr(namedArgs: {'name': name})
                : 'aiStore.title'.tr(),
            style: textTheme.titleMedium,
          ),
          const SizedBox(height: AppSpacing.space4),
          Text(
            'aiStore.price'.tr(namedArgs: {'price': offer.price}),
            style: textTheme.headlineSmall,
          ),
          const SizedBox(height: AppSpacing.space12),
          CheckboxListTile(
            key: const ValueKey('aiStore.waiver'),
            value: offer.waiverAcknowledged,
            onChanged: busy ? null : (value) => controller.acknowledgeWaiver(value ?? false),
            controlAffinity: ListTileControlAffinity.leading,
            contentPadding: EdgeInsets.zero,
            dense: true,
            title: Text('aiStore.waiver.label'.tr(), style: textTheme.bodyMedium),
          ),
          const SizedBox(height: AppSpacing.space8),
          FilledButton(
            onPressed: busy || !offer.waiverAcknowledged ? null : controller.buy,
            child: offer.busy == AiStoreBusy.purchasing
                ? const SizedBox.square(
                    dimension: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : Text('aiStore.subscribe'.tr()),
          ),
          if (offer.busy == AiStoreBusy.restoring) ...[
            const SizedBox(height: AppSpacing.space12),
            Row(
              key: const ValueKey('aiStore.restoring'),
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                const SizedBox.square(
                  dimension: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
                const SizedBox(width: AppSpacing.space8),
                Text('aiStore.restore.inProgress'.tr(), style: textTheme.bodySmall),
              ],
            ),
          ],
          if (offer.messageKey case final key?) ...[
            const SizedBox(height: AppSpacing.space8),
            Text(
              key.tr(namedArgs: {'name': name ?? 'aiStore.thisStudent'.tr()}),
              key: const ValueKey('aiStore.message'),
              style: textTheme.bodySmall?.copyWith(
                color: offer.messageIsError ? colorScheme.error : colorScheme.onSurfaceVariant,
              ),
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
              TextButton(
                onPressed: () =>
                    launchUrl(ref.read(termsUrlProvider), mode: LaunchMode.externalApplication),
                child: Text('aiStore.links.termsOfService'.tr()),
              ),
              if (apple)
                TextButton(
                  onPressed: () =>
                      launchUrl(appleStandardEulaUrl, mode: LaunchMode.externalApplication),
                  child: Text('aiStore.links.terms'.tr()),
                ),
              // Small, last, and behind a confirmation: required by the stores, rarely needed.
              TextButton(
                key: const ValueKey('aiStore.restore'),
                onPressed: busy ? null : () => _confirmRestore(context, controller),
                child: Text('aiStore.restore.action'.tr()),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
