import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/ai_consent_providers.dart';
import '../../domain/ai_consent.dart';
import 'ai_consent_dialog.dart';

/// Builds [child] — an AI feature screen — only once the user has consented to sharing their AI
/// inputs with the third-party model provider (ST-305). Until then the feature screen is never
/// built, so it cannot issue a request; the consent modal opens on arrival, and a locked page
/// with a button to reopen it stays behind if the user declines.
///
/// This is the client half. The API refuses every model-calling route with
/// `403 AI_CONSENT_REQUIRED` without a recorded consent regardless, so a screen reached some other
/// way still sends nothing.
class AiConsentGate extends ConsumerStatefulWidget {
  const AiConsentGate({required this.child, super.key});

  final Widget child;

  @override
  ConsumerState<AiConsentGate> createState() => _AiConsentGateState();
}

class _AiConsentGateState extends ConsumerState<AiConsentGate> {
  /// Open the modal on its own only once per visit; after a decline the locked page's button
  /// reopens it, rather than the modal reappearing on every rebuild.
  bool _prompted = false;

  void _promptOnce(AiDataSharingDisclosure disclosure) {
    if (_prompted) return;
    _prompted = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) showAiConsentDialog(context, disclosure);
    });
  }

  @override
  Widget build(BuildContext context) {
    return ref
        .watch(aiConsentProvider)
        .when(
          data: (status) {
            if (status.isGranted) return widget.child;
            _promptOnce(status.disclosure);
            return _AiConsentLockedPage(disclosure: status.disclosure);
          },
          loading: () => Scaffold(
            appBar: AppBar(),
            body: const Center(child: CircularProgressIndicator()),
          ),
          error: (error, stackTrace) => Scaffold(
            appBar: AppBar(title: Text('ai.hub.title'.tr())),
            body: const AiConsentLoadError(),
          ),
        );
  }
}

class _AiConsentLockedPage extends StatelessWidget {
  const _AiConsentLockedPage({required this.disclosure});

  final AiDataSharingDisclosure disclosure;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;

    return Scaffold(
      appBar: AppBar(title: Text('ai.hub.title'.tr())),
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.space32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.lock_outline, size: 32, color: colorScheme.onSurfaceVariant),
              const SizedBox(height: AppSpacing.space12),
              Text(
                'ai.consent.locked.title'.tr(),
                style: textTheme.titleMedium,
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: AppSpacing.space8),
              Text(
                'ai.consent.locked.message'.tr(namedArgs: {'provider': disclosure.providerName}),
                style: textTheme.bodyMedium?.copyWith(color: colorScheme.onSurfaceVariant),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: AppSpacing.space16),
              FilledButton(
                onPressed: () => showAiConsentDialog(context, disclosure),
                child: Text('ai.consent.locked.review'.tr()),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// The consent status couldn't be loaded; retrying refetches it.
class AiConsentLoadError extends ConsumerWidget {
  const AiConsentLoadError({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final colorScheme = Theme.of(context).colorScheme;

    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              'ai.consent.loadError'.tr(),
              style: TextStyle(color: colorScheme.onSurfaceVariant),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: AppSpacing.space12),
            TextButton(
              onPressed: () => ref.invalidate(aiConsentProvider),
              child: Text('aiStudy.retry'.tr()),
            ),
          ],
        ),
      ),
    );
  }
}
