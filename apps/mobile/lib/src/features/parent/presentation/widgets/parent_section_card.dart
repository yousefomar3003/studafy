import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/kit/kit.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';

/// The chrome every parent-home card shares: the kit's [AppSectionCard] (coloured icon badge,
/// bold title, optional header-trailing badge or count) over a body [child] each card fills with
/// its own loading / content / empty / error state. Mirrors the student screens'
/// `TodayCardShell` and the teacher screens' `TeacherSectionCard`. [accent] colour-codes the
/// section.
class ParentSectionCard extends StatelessWidget {
  const ParentSectionCard({
    required this.titleKey,
    required this.icon,
    required this.child,
    this.trailing,
    this.accent = AppAccent.blue,
    super.key,
  });

  final String titleKey;
  final IconData icon;
  final Widget child;
  final Widget? trailing;
  final AppAccent accent;

  @override
  Widget build(BuildContext context) {
    return AppSectionCard(
      title: titleKey.tr(),
      icon: icon,
      accent: accent,
      trailing: trailing,
      child: child,
    );
  }
}

/// A one-line, icon-led message for a card's non-content states (empty or errored): the kit's
/// compact [AppEmptyState]. Mirrors the teacher screens' `TeacherCardMessage`.
class ParentCardMessage extends StatelessWidget {
  const ParentCardMessage({required this.messageKey, required this.icon, super.key});

  final String messageKey;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    return AppEmptyState(
      compact: true,
      icon: icon,
      message: messageKey.tr(),
      accent: AppEmptyState.accentForIcon(icon),
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
            alignment: AlignmentDirectional.centerStart,
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
