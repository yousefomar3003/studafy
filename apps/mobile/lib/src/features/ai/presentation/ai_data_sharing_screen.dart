import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/ai_consent_providers.dart';
import '../domain/ai_consent.dart';
import 'widgets/ai_consent_dialog.dart';
import 'widgets/ai_consent_disclosure.dart';
import 'widgets/ai_consent_gate.dart';

/// AI data sharing (ST-305): what is shared with the third-party model provider, whether the user
/// has allowed it, and the way to withdraw — or grant — that consent. Reached from the AI hub's
/// app bar in every hub state, so withdrawal never depends on the AI add-on being active.
class AiDataSharingScreen extends ConsumerWidget {
  const AiDataSharingScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Scaffold(
      appBar: AppBar(title: Text('ai.dataSharing.title'.tr())),
      body: ref
          .watch(aiConsentProvider)
          .when(
            data: (status) => _AiDataSharingBody(status: status),
            loading: () => const Center(child: CircularProgressIndicator()),
            error: (error, stackTrace) => const AiConsentLoadError(),
          ),
    );
  }
}

class _AiDataSharingBody extends ConsumerWidget {
  const _AiDataSharingBody({required this.status});

  final AiConsentStatus status;

  Future<void> _withdraw(BuildContext context, WidgetRef ref) async {
    final provider = {'provider': status.disclosure.providerName};
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text('ai.dataSharing.withdrawConfirm.title'.tr()),
        content: Text('ai.dataSharing.withdrawConfirm.message'.tr(namedArgs: provider)),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: Text('ai.dataSharing.withdrawConfirm.cancel'.tr()),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: Text('ai.dataSharing.withdrawConfirm.confirm'.tr()),
          ),
        ],
      ),
    );
    if (confirmed != true || !context.mounted) return;

    try {
      await ref.read(aiConsentProvider.notifier).withdraw();
    } catch (_) {
      if (context.mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('ai.dataSharing.withdrawError'.tr())));
      }
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final textTheme = Theme.of(context).textTheme;
    final grantedAt = status.grantedAt;

    return ListView(
      padding: const EdgeInsets.all(AppSpacing.space24),
      children: [
        AiConsentDisclosure(disclosure: status.disclosure),
        const SizedBox(height: AppSpacing.space24),
        Text(
          grantedAt == null
              ? 'ai.dataSharing.notGranted'.tr()
              : 'ai.dataSharing.granted'.tr(
                  namedArgs: {
                    'date': DateFormat.yMMMd(context.locale.toString()).format(grantedAt.toLocal()),
                  },
                ),
          style: textTheme.titleSmall,
        ),
        const SizedBox(height: AppSpacing.space12),
        if (grantedAt == null)
          FilledButton(
            onPressed: () => showAiConsentDialog(context, status.disclosure),
            child: Text('ai.dataSharing.allow'.tr()),
          )
        else
          OutlinedButton(
            onPressed: () => _withdraw(context, ref),
            child: Text('ai.dataSharing.withdraw'.tr()),
          ),
      ],
    );
  }
}
