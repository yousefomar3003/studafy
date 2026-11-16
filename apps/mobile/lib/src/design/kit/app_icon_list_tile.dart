import 'package:flutter/material.dart';

import '../tokens/app_accent_tokens.dart';
import '../tokens/app_radius_tokens.dart';
import '../tokens/app_spacing_tokens.dart';
import 'app_card_surface.dart';
import 'app_icon_badge.dart';

/// A list row led by a coloured badge: the badge ([leading], or an [AppIconBadge] built from
/// [icon] / [badgeLabel] in [accent]), a bold [title] with an optional muted [subtitle], and an
/// optional [trailing] widget (usually an [AppStatusPill]), or a [footer] under the text for a
/// pill too wide to share the line with the title. Tappable rows ([onTap]) get a
/// direction-aware chevron unless [showChevron] says otherwise.
///
/// For a row inside a section card; [AppIconListCard] is the same row as a stand-alone card.
class AppIconListTile extends StatelessWidget {
  const AppIconListTile({
    required this.title,
    this.subtitle,
    this.icon,
    this.badgeLabel,
    this.leading,
    this.accent = AppAccent.blue,
    this.trailing,
    this.footer,
    this.onTap,
    this.showChevron,
    this.titleMaxLines = 1,
    this.subtitleMaxLines = 2,
    this.padding = const EdgeInsets.symmetric(vertical: AppSpacing.space8),
    super.key,
  });

  final String title;
  final String? subtitle;
  final IconData? icon;

  /// Short text in the badge instead of an icon (a period number).
  final String? badgeLabel;

  /// Replaces the badge entirely (an avatar, a date block).
  final Widget? leading;
  final AppAccent accent;
  final Widget? trailing;

  /// Under the title and subtitle, aligned with them (e.g. a long status pill).
  final Widget? footer;
  final VoidCallback? onTap;

  /// Whether to end with a chevron; defaults to whether the row is tappable.
  final bool? showChevron;
  final int titleMaxLines;
  final int subtitleMaxLines;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final lead =
        leading ??
        (icon != null || badgeLabel != null
            ? AppIconBadge(icon: icon, label: badgeLabel, accent: accent)
            : null);

    final row = Padding(
      padding: padding,
      child: Row(
        children: [
          if (lead != null) ...[
            lead,
            const SizedBox(width: AppSpacing.space12),
          ],
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  title,
                  maxLines: titleMaxLines,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.bodyLarge?.copyWith(
                    fontWeight: FontWeight.w600,
                    height: 1.3,
                  ),
                ),
                if (subtitle != null && subtitle!.isNotEmpty) ...[
                  const SizedBox(height: 2),
                  Text(
                    subtitle!,
                    maxLines: subtitleMaxLines,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: colors.onSurfaceVariant,
                    ),
                  ),
                ],
                if (footer != null) ...[
                  const SizedBox(height: AppSpacing.space8 - 2),
                  footer!,
                ],
              ],
            ),
          ),
          if (trailing != null) ...[
            const SizedBox(width: AppSpacing.space8),
            trailing!,
          ],
          if (showChevron ?? onTap != null) ...[
            const SizedBox(width: AppSpacing.space4),
            // chevron_right mirrors itself in RTL (matchTextDirection).
            Icon(Icons.chevron_right, size: 20, color: colors.onSurfaceVariant),
          ],
        ],
      ),
    );

    if (onTap == null) return row;
    return InkWell(onTap: onTap, borderRadius: AppRadius.mdRadius, child: row);
  }
}

/// An [AppIconListTile] on its own card, for a list of top-level items (classes, entry points).
class AppIconListCard extends StatelessWidget {
  const AppIconListCard({
    required this.title,
    this.subtitle,
    this.icon,
    this.badgeLabel,
    this.leading,
    this.accent = AppAccent.blue,
    this.trailing,
    this.onTap,
    this.showChevron = true,
    this.color,
    super.key,
  });

  final String title;
  final String? subtitle;
  final IconData? icon;
  final String? badgeLabel;
  final Widget? leading;
  final AppAccent accent;
  final Widget? trailing;
  final VoidCallback? onTap;
  final bool showChevron;

  /// Card colour override (e.g. a tinted call-to-action card).
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final tile = AppIconListTile(
      title: title,
      subtitle: subtitle,
      icon: icon,
      badgeLabel: badgeLabel,
      leading: leading,
      accent: accent,
      trailing: trailing,
      showChevron: onTap != null && showChevron,
      padding: const EdgeInsets.all(AppSpacing.space12),
    );

    // The ink spans the whole card (not just the tile's padding box), so the card ripples edge
    // to edge and clips to its rounded corners.
    return AppCardSurface(
      color: color,
      child: onTap == null ? tile : InkWell(onTap: onTap, child: tile),
    );
  }
}
