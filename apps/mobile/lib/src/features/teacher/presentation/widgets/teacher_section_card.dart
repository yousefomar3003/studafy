import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';

/// The chrome every teacher-home card shares: an icon + title header over a body [child] that
/// each card fills with its own loading / content / empty / error state.
class TeacherSectionCard extends StatelessWidget {
  const TeacherSectionCard({
    required this.titleKey,
    required this.icon,
    required this.child,
    this.trailing,
    super.key,
  });

  final String titleKey;
  final IconData icon;
  final Widget child;

  /// Optional header-trailing widget, e.g. a count badge.
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
/// student screens' `TodayStateMessage`.
class TeacherCardMessage extends StatelessWidget {
  const TeacherCardMessage({required this.messageKey, required this.icon, super.key});

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

/// A static, three-bar loading placeholder for a card body. Not animated, for the same reason
/// the student screens' `TodaySkeleton` isn't: a repeating animation never lets `pumpAndSettle`
/// (and every golden that uses it) settle.
class TeacherCardSkeleton extends StatelessWidget {
  const TeacherCardSkeleton({this.lineCount = 3, super.key});

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
