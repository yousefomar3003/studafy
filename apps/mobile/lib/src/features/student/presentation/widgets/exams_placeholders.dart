import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/tokens/app_radius_tokens.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';

/// A centered icon-led message filling the exams screen's body for any non-loading, non-content
/// state: unavailable, empty, or errored, with an optional second line ([hintKey]). Kept
/// scrollable so the screen's pull-to-refresh still works while it is showing — the same shape
/// the attendance screen uses.
class ExamsMessage extends StatelessWidget {
  const ExamsMessage({
    required this.messageKey,
    required this.icon,
    this.hintKey,
    super.key,
  });

  final String messageKey;
  final String? hintKey;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    final hint = hintKey;

    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.all(AppSpacing.space32),
      children: [
        Column(
          children: [
            Icon(icon, size: 32, color: colorScheme.onSurfaceVariant),
            const SizedBox(height: AppSpacing.space12),
            Text(
              messageKey.tr(),
              textAlign: TextAlign.center,
              style: textTheme.bodyMedium?.copyWith(color: colorScheme.onSurfaceVariant),
            ),
            if (hint != null) ...[
              const SizedBox(height: AppSpacing.space4),
              Text(
                hint.tr(),
                textAlign: TextAlign.center,
                style: textTheme.bodySmall?.copyWith(color: colorScheme.onSurfaceVariant),
              ),
            ],
          ],
        ),
      ],
    );
  }
}

/// A static loading placeholder for the exams screen: a few faux day sections of muted bars.
/// Static, not animated, for the same reason `TimetableSkeleton` is — a repeating controller
/// never lets `pumpAndSettle` settle.
class ExamsSkeleton extends StatelessWidget {
  const ExamsSkeleton({super.key});

  @override
  Widget build(BuildContext context) {
    final color = Theme.of(context).colorScheme.surfaceContainerHighest;

    Widget bar(double widthFactor, double height) => FractionallySizedBox(
      alignment: AlignmentDirectional.centerStart,
      widthFactor: widthFactor,
      child: DecoratedBox(
        decoration: BoxDecoration(color: color, borderRadius: AppRadius.smRadius),
        child: SizedBox(height: height),
      ),
    );

    return ListView(
      padding: const EdgeInsets.all(AppSpacing.space16),
      physics: const AlwaysScrollableScrollPhysics(),
      children: [
        for (var section = 0; section < 3; section++) ...[
          if (section > 0) const SizedBox(height: AppSpacing.space24),
          bar(0.4, 18),
          const SizedBox(height: AppSpacing.space12),
          bar(0.95, 52),
          const SizedBox(height: AppSpacing.space8),
          bar(0.95, 52),
        ],
      ],
    );
  }
}
