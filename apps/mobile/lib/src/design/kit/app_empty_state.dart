import 'package:flutter/material.dart';

import '../tokens/app_accent_tokens.dart';
import '../tokens/app_spacing_tokens.dart';
import 'app_tone.dart';

/// An illustration-style message for an empty, unavailable or failed section, drawn from icons
/// alone (no image assets): the icon in a tinted disc inside a fainter halo, a [message], an
/// optional bolder [title] above it and an optional [action] below.
///
/// [compact] renders a one-line version (small disc beside the message) for inside a card body.
class AppEmptyState extends StatelessWidget {
  const AppEmptyState({
    required this.icon,
    required this.message,
    this.title,
    this.action,
    this.accent = AppAccent.slate,
    this.compact = false,
    super.key,
  });

  final IconData icon;
  final String message;
  final String? title;
  final Widget? action;
  final AppAccent accent;
  final bool compact;

  /// The tint a state message's [icon] implies: red for an error, green for an all-done check,
  /// slate for everything else (empty, unavailable, informational).
  static AppAccent accentForIcon(IconData icon) {
    if (icon == Icons.error_outline) return AppTone.danger.accent;
    if (icon == Icons.check_circle_outline) return AppTone.success.accent;
    return AppAccent.slate;
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = accent.colorsOf(context);
    final muted = theme.colorScheme.onSurfaceVariant;

    if (compact) {
      return Row(
        children: [
          _Disc(icon: icon, colors: colors, size: 36, haloWidth: 0),
          const SizedBox(width: AppSpacing.space12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                if (title != null)
                  Text(
                    title!,
                    style: theme.textTheme.bodyMedium?.copyWith(
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                Text(
                  message,
                  style: theme.textTheme.bodyMedium?.copyWith(color: muted),
                ),
              ],
            ),
          ),
          if (action != null) ...[
            const SizedBox(width: AppSpacing.space8),
            action!,
          ],
        ],
      );
    }

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.space24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          _Disc(icon: icon, colors: colors, size: 72, haloWidth: 12),
          const SizedBox(height: AppSpacing.space16),
          if (title != null) ...[
            Text(
              title!,
              textAlign: TextAlign.center,
              style: theme.textTheme.titleMedium?.copyWith(
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: AppSpacing.space4),
          ],
          Text(
            message,
            textAlign: TextAlign.center,
            style: theme.textTheme.bodyMedium?.copyWith(color: muted),
          ),
          if (action != null) ...[
            const SizedBox(height: AppSpacing.space16),
            action!,
          ],
        ],
      ),
    );
  }
}

class _Disc extends StatelessWidget {
  const _Disc({
    required this.icon,
    required this.colors,
    required this.size,
    required this.haloWidth,
  });

  final IconData icon;
  final AppAccentColors colors;
  final double size;
  final double haloWidth;

  @override
  Widget build(BuildContext context) {
    return ExcludeSemantics(
      child: Container(
        width: size + haloWidth * 2,
        height: size + haloWidth * 2,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          color: colors.container.withValues(alpha: haloWidth == 0 ? 0 : 0.45),
        ),
        alignment: Alignment.center,
        child: Container(
          width: size,
          height: size,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: colors.container,
          ),
          child: Icon(icon, size: size * 0.48, color: colors.onContainer),
        ),
      ),
    );
  }
}
