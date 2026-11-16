import 'package:flutter/material.dart';

import '../tokens/app_radius_tokens.dart';
import '../tokens/app_spacing_tokens.dart';
import 'app_tone.dart';

/// A small, fully rounded status label ("Recorded", "Late", "92%") in a tone's soft tint, with an
/// optional leading icon. The text carries the meaning; the colour only reinforces it.
class AppStatusPill extends StatelessWidget {
  const AppStatusPill({
    required this.label,
    this.tone = AppTone.neutral,
    this.icon,
    super.key,
  });

  final String label;
  final AppTone tone;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final colors = tone.colorsOf(context);

    return DecoratedBox(
      decoration: BoxDecoration(
        color: colors.container,
        borderRadius: AppRadius.fullRadius,
      ),
      child: Padding(
        padding: EdgeInsetsDirectional.fromSTEB(
          icon == null ? AppSpacing.space8 + 2 : AppSpacing.space8,
          AppSpacing.space4,
          AppSpacing.space8 + 2,
          AppSpacing.space4,
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (icon != null) ...[
              Icon(icon, size: 14, color: colors.onContainer),
              const SizedBox(width: AppSpacing.space4),
            ],
            Flexible(
              child: Text(
                label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: Theme.of(context).textTheme.labelMedium?.copyWith(
                  color: colors.onContainer,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
