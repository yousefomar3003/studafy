import 'package:flutter/material.dart';

import '../tokens/app_accent_tokens.dart';
import '../tokens/app_radius_tokens.dart';
import '../tokens/app_spacing_tokens.dart';
import 'app_tone.dart';

/// One headline number on an accent tint: a small icon, the [value] large, and its [label]
/// underneath ("88%" / "Term average"). Lay two or three side by side in a [Row] with [Expanded]
/// for a dashboard summary strip.
class AppStatTile extends StatelessWidget {
  const AppStatTile({
    required this.value,
    required this.label,
    required this.icon,
    this.accent = AppAccent.blue,
    this.footer,
    super.key,
  });

  final String value;
  final String label;
  final IconData icon;
  final AppAccent accent;

  /// Optional extra line under the label (e.g. an [AppStatusPill] with a trend).
  final Widget? footer;

  @override
  Widget build(BuildContext context) {
    final colors = accent.colorsOf(context);
    final textTheme = Theme.of(context).textTheme;

    return Semantics(
      container: true,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: colors.container,
          borderRadius: AppRadius.lgRadius,
        ),
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.space12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(icon, size: 20, color: colors.onContainer),
              const SizedBox(height: AppSpacing.space8),
              Text(
                value,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: textTheme.headlineSmall?.copyWith(
                  color: colors.onContainer,
                  fontWeight: FontWeight.w700,
                  fontFeatures: const [FontFeature.tabularFigures()],
                ),
              ),
              Text(
                label,
                style: textTheme.bodySmall?.copyWith(
                  color: colors.onContainer,
                  fontWeight: FontWeight.w500,
                ),
              ),
              if (footer != null) ...[
                const SizedBox(height: AppSpacing.space8),
                footer!,
              ],
            ],
          ),
        ),
      ),
    );
  }
}
