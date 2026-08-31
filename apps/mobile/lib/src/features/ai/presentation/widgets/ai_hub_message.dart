import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';

/// A one-line, icon-led message filling the AI tab's body for a non-loading, non-content state
/// this screen has no dedicated widget for: the student context couldn't be resolved yet, or a
/// transient fetch error. Kept scrollable so the screen's pull-to-refresh still works while it's
/// showing — mirrors `GradesMessage`/`TimetableMessage`.
class AiHubMessage extends StatelessWidget {
  const AiHubMessage({required this.messageKey, required this.icon, super.key});

  final String messageKey;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;

    return ListView(
      padding: const EdgeInsets.all(AppSpacing.space24),
      physics: const AlwaysScrollableScrollPhysics(),
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(icon, size: 20, color: colorScheme.onSurfaceVariant),
            const SizedBox(width: AppSpacing.space8),
            Expanded(
              child: Text(
                messageKey.tr(),
                style: textTheme.bodyMedium?.copyWith(color: colorScheme.onSurfaceVariant),
              ),
            ),
          ],
        ),
      ],
    );
  }
}
