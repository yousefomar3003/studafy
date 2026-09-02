import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/tokens/app_radius_tokens.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';

/// A one-line, icon-led message filling a child-detail tab for any non-loading, non-content
/// state: the term breakdown errored, a section is empty, or the section has no parent-scoped
/// data source yet. Kept scrollable so each tab's pull-to-refresh keeps working while it shows.
/// Mirrors the student screens' `GradesMessage` / `TimetableMessage`.
class ChildDetailMessage extends StatelessWidget {
  const ChildDetailMessage({
    required this.messageKey,
    required this.icon,
    this.hintKey,
    this.messageArgs,
    super.key,
  });

  final String messageKey;
  final String? hintKey;
  final IconData icon;

  /// Named substitutions for [messageKey], e.g. a linked-child count. Null for the common case of
  /// a message with no variable part.
  final Map<String, String>? messageArgs;

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
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    messageKey.tr(namedArgs: messageArgs),
                    style: textTheme.bodyMedium?.copyWith(color: colorScheme.onSurfaceVariant),
                  ),
                  if (hintKey case final hintKey?) ...[
                    const SizedBox(height: AppSpacing.space4),
                    Text(
                      hintKey.tr(),
                      style: textTheme.bodySmall?.copyWith(color: colorScheme.onSurfaceVariant),
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ],
    );
  }
}

/// A static loading placeholder for a child-detail tab: a header block over a couple of faux
/// cards, all muted bars. Static, not animated, for the same reason `GradesSkeleton` is — a
/// repeating controller never lets `pumpAndSettle` settle.
class ChildDetailSkeleton extends StatelessWidget {
  const ChildDetailSkeleton({super.key});

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
        bar(0.5, 18),
        const SizedBox(height: AppSpacing.space12),
        bar(0.9, 44),
        const SizedBox(height: AppSpacing.space24),
        for (var card = 0; card < 2; card++) ...[
          if (card > 0) const SizedBox(height: AppSpacing.space16),
          bar(0.45, 16),
          const SizedBox(height: AppSpacing.space8),
          bar(0.8, 14),
          const SizedBox(height: AppSpacing.space8),
          bar(0.65, 14),
        ],
      ],
    );
  }
}
