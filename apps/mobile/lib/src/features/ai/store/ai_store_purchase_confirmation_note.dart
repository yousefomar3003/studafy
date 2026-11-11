import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../design/tokens/app_radius_tokens.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import 'ai_store_controller.dart';

/// The in-app copy of the purchase confirmation: when the student, before buying the AI add-on in
/// the app, asked for it to start now and acknowledged losing the 14-day right to cancel, and the
/// Terms of Service version it was bought under.
///
/// The law asks for that confirmation on a durable medium. It is emailed; a member-ID student with
/// no email address gets it only here, which is why it is shown to everyone who has one recorded
/// (and says when it was emailed too). Renders nothing while loading or when none was recorded.
class AiStorePurchaseConfirmationNote extends ConsumerWidget {
  const AiStorePurchaseConfirmationNote({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final confirmation = ref.watch(aiStorePurchaseConfirmationProvider).value;
    if (confirmation == null) return const SizedBox.shrink();

    final colorScheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    final date = DateFormat.yMMMd(
      context.locale.toString(),
    ).add_jm().format(confirmation.acknowledgedAt.toLocal());

    return Container(
      key: const ValueKey('aiStore.confirmation'),
      width: double.infinity,
      margin: const EdgeInsets.only(top: AppSpacing.space16),
      padding: const EdgeInsets.all(AppSpacing.space16),
      decoration: BoxDecoration(
        border: Border.all(color: colorScheme.outlineVariant),
        borderRadius: AppRadius.lgRadius,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('aiStore.confirmation.title'.tr(), style: textTheme.titleSmall),
          const SizedBox(height: AppSpacing.space8),
          Text(
            'aiStore.confirmation.body'.tr(
              namedArgs: {'date': date, 'version': confirmation.termsVersion},
            ),
            style: textTheme.bodySmall,
          ),
          if (confirmation.emailed) ...[
            const SizedBox(height: AppSpacing.space4),
            Text(
              'aiStore.confirmation.emailed'.tr(),
              style: textTheme.bodySmall?.copyWith(color: colorScheme.onSurfaceVariant),
            ),
          ],
        ],
      ),
    );
  }
}
