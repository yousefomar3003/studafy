import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/tokens/app_radius_tokens.dart';
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

    // Mirrors the web card's header/body split (`packages/ui/src/components/card/card.css`):
    // a 16px-padded header over a hairline divider, then a 16px-padded body.
    return Card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: AppSpacing.space16,
              vertical: AppSpacing.space12,
            ),
            child: Row(
              children: [
                DecoratedBox(
                  decoration: BoxDecoration(
                    color: colorScheme.primaryContainer,
                    borderRadius: AppRadius.mdRadius,
                  ),
                  child: Padding(
                    padding: const EdgeInsets.all(AppSpacing.space8),
                    child: Icon(
                      icon,
                      size: 18,
                      color: colorScheme.onPrimaryContainer,
                    ),
                  ),
                ),
                const SizedBox(width: AppSpacing.space12),
                Expanded(
                  child: Text(
                    titleKey.tr(),
                    style: textTheme.titleSmall?.copyWith(
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ],
            ),
          ),
          const Divider(),
          Padding(
            padding: const EdgeInsets.all(AppSpacing.space16),
            child: child,
          ),
        ],
      ),
    );
  }
}
