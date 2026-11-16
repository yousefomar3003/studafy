import 'package:flutter/material.dart';

import '../tokens/app_accent_tokens.dart';
import '../tokens/app_spacing_tokens.dart';
import 'app_icon_badge.dart';

/// A section title led by a coloured icon badge, with an optional [trailing] widget (a count, a
/// "View all" button) at the end. Used on its own between groups on a page, and as the header of
/// [AppSectionCard].
class AppSectionHeader extends StatelessWidget {
  const AppSectionHeader({
    required this.title,
    required this.icon,
    this.accent = AppAccent.blue,
    this.subtitle,
    this.trailing,
    this.badgeSize = 36,
    super.key,
  });

  final String title;
  final IconData icon;
  final AppAccent accent;
  final String? subtitle;
  final Widget? trailing;
  final double badgeSize;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Row(
      children: [
        AppIconBadge(icon: icon, accent: accent, size: badgeSize),
        const SizedBox(width: AppSpacing.space12),
        Expanded(
          child: Semantics(
            header: true,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  title,
                  style: theme.textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w700,
                  ),
                ),
                if (subtitle != null)
                  Text(
                    subtitle!,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
              ],
            ),
          ),
        ),
        if (trailing != null) ...[
          const SizedBox(width: AppSpacing.space8),
          trailing!,
        ],
      ],
    );
  }
}
