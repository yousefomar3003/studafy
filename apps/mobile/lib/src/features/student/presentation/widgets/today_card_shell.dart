import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';

/// The common chrome every today-screen card shares: an icon+title header over a body [child]
/// that each card fills with its own skeleton/content/empty/error state.
class TodayCardShell extends StatelessWidget {
  const TodayCardShell({
    required this.titleKey,
    required this.icon,
    required this.child,
    super.key,
  });

  final String titleKey;
  final IconData icon;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(icon, size: 20, color: colorScheme.primary),
                const SizedBox(width: AppSpacing.space8),
                Text(titleKey.tr(), style: textTheme.titleMedium),
              ],
            ),
            const SizedBox(height: AppSpacing.space12),
            child,
          ],
        ),
      ),
    );
  }
}
