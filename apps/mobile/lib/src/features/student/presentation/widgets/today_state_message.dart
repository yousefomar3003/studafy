import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';

/// A one-line, icon-led message filling a today-screen card's body for any non-loading,
/// non-content state: empty, unavailable, or errored. The three call sites
/// ([TodayGradesCard], [TodayTimetableCard], etc.) only vary the icon and translation key.
class TodayStateMessage extends StatelessWidget {
  const TodayStateMessage({required this.messageKey, required this.icon, super.key});

  final String messageKey;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;

    return Row(
      children: [
        Icon(icon, size: 18, color: colorScheme.onSurfaceVariant),
        const SizedBox(width: AppSpacing.space8),
        Expanded(
          child: Text(
            messageKey.tr(),
            style: textTheme.bodyMedium?.copyWith(color: colorScheme.onSurfaceVariant),
          ),
        ),
      ],
    );
  }
}
