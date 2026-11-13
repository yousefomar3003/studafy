import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/tokens/app_radius_tokens.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../domain/ai_study.dart';

/// The shared failure card for the AI study screens: one line of localized guidance per
/// [AiStudyError] case, with a retry button for the recoverable ones.
///
/// [compact] drops the icon and centring so it can sit inline above stale content the screen is
/// still showing (a summary from a previous preset, say); the default is the full-screen centred
/// form for when there is nothing else to show.
class AiErrorView extends StatelessWidget {
  const AiErrorView({
    required this.error,
    required this.onRetry,
    this.compact = false,
    super.key,
  });

  final AiStudyError error;
  final Future<void> Function() onRetry;
  final bool compact;

  /// Retrying only helps for the transient cases; for the rest it just repeats the same answer.
  bool get _canRetry => switch (error) {
    AiStudyError.temporarilyUnavailable ||
    AiStudyError.generationFailed ||
    AiStudyError.notReady ||
    AiStudyError.network ||
    AiStudyError.unknown => true,
    _ => false,
  };

  String get _messageKey => 'aiStudy.error.${error.name}';

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;

    final card = Container(
      padding: const EdgeInsets.all(AppSpacing.space12),
      decoration: BoxDecoration(
        color: colorScheme.errorContainer,
        borderRadius: AppRadius.lgRadius,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (!compact) ...[
                Icon(Icons.error_outline, size: 18, color: colorScheme.onErrorContainer),
                const SizedBox(width: AppSpacing.space8),
              ],
              Expanded(
                child: Text(
                  _messageKey.tr(),
                  style: TextStyle(color: colorScheme.onErrorContainer),
                ),
              ),
            ],
          ),
          if (_canRetry)
            Align(
              alignment: AlignmentDirectional.centerEnd,
              child: TextButton(
                onPressed: () => onRetry(),
                child: Text('aiStudy.retry'.tr()),
              ),
            ),
        ],
      ),
    );

    if (compact) return card;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space24),
        child: card,
      ),
    );
  }
}

/// Shown in place of a study screen's body when there is no signed-in session.
class AiSignedOutView extends StatelessWidget {
  const AiSignedOutView({super.key});

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.lock_outline, size: 32, color: colorScheme.onSurfaceVariant),
            const SizedBox(height: AppSpacing.space12),
            Text(
              'aiStudy.signedOut'.tr(),
              textAlign: TextAlign.center,
              style: TextStyle(color: colorScheme.onSurfaceVariant),
            ),
          ],
        ),
      ),
    );
  }
}
