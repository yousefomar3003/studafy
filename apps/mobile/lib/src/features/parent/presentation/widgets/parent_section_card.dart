import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';

/// The chrome every parent-home card shares: an icon + title header, an optional header-trailing
/// widget (a badge or count), over a body [child] each card fills with its own loading /
/// content / empty / error state. Mirrors the student screens' `TodayCardShell` and the teacher
/// screens' `TeacherSectionCard`.
class ParentSectionCard extends StatelessWidget {
  const ParentSectionCard({
    required this.titleKey,
    required this.icon,
    required this.child,
    this.trailing,
    super.key,
  });

  final String titleKey;
  final IconData icon;
  final Widget child;
  final Widget? trailing;

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
                Expanded(child: Text(titleKey.tr(), style: textTheme.titleMedium)),
                ?trailing,
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

/// A one-line, icon-led message for a card's non-content states (empty or errored). Mirrors the
/// teacher screens' `TeacherCardMessage`.
class ParentCardMessage extends StatelessWidget {
  const ParentCardMessage({required this.messageKey, required this.icon, super.key});

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

/// A static, non-animated loading placeholder for a card body — animation would never let
/// `pumpAndSettle` (and every golden that uses it) settle. Mirrors `TeacherCardSkeleton`.
class ParentCardSkeleton extends StatelessWidget {
  const ParentCardSkeleton({this.lineCount = 3, super.key});

  final int lineCount;

  @override
  Widget build(BuildContext context) {
    final color = Theme.of(context).colorScheme.surfaceContainerHighest;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (var i = 0; i < lineCount; i++) ...[
          if (i > 0) const SizedBox(height: AppSpacing.space8),
          FractionallySizedBox(
            alignment: Alignment.centerLeft,
            widthFactor: i.isEven ? 0.85 : 0.55,
            child: DecoratedBox(
              decoration: BoxDecoration(
                color: color,
                borderRadius: BorderRadius.circular(4),
              ),
              child: const SizedBox(height: 14),
            ),
          ),
        ],
      ],
    );
  }
}
