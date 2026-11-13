import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

/// The review streak indicator: a flame glyph plus the consecutive-day count
/// (`FlashcardLibrary.streak`). Dims to the neutral icon at zero rather than hiding — a visible
/// "0" is what tells a student today is the day to keep it alive, same reasoning most habit
/// trackers use.
class FlashcardStreakBadge extends StatelessWidget {
  const FlashcardStreakBadge({required this.streak, super.key});

  final int streak;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final active = streak > 0;
    final color = active ? colorScheme.primary : colorScheme.onSurfaceVariant;

    return Semantics(
      label: 'flashcards.library.streak'.tr(namedArgs: {'count': '$streak'}),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(active ? Icons.local_fire_department : Icons.local_fire_department_outlined, color: color, size: 20),
          const SizedBox(width: 4),
          Text('$streak', style: Theme.of(context).textTheme.titleSmall?.copyWith(color: color)),
        ],
      ),
    );
  }
}
