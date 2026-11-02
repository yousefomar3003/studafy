import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../domain/flashcard_state.dart';

/// One deck row in the browser: its materials, card count, and due-today count. [onStudy] is null
/// while the due count is still loading — the tile shows a progress indicator instead of a button
/// that would start a session against a number that isn't known yet.
class FlashcardDeckTile extends StatelessWidget {
  const FlashcardDeckTile({required this.entry, required this.onStudy, super.key});

  final FlashcardDeckEntry entry;
  final VoidCallback? onStudy;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    final summary = entry.summary;
    final title = summary.materialTitles.isEmpty
        ? 'flashcards.library.untitledDeck'.tr()
        : summary.materialTitles.join(' · ');
    final dueCount = entry.dueCount;

    return Card(
      margin: const EdgeInsets.only(bottom: AppSpacing.space12),
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space16),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, style: textTheme.titleSmall, maxLines: 2, overflow: TextOverflow.ellipsis),
                  const SizedBox(height: AppSpacing.space4),
                  Text(
                    'flashcards.library.cardCount'.tr(namedArgs: {'count': '${summary.cardCount}'}),
                    style: textTheme.bodySmall?.copyWith(color: colorScheme.onSurfaceVariant),
                  ),
                  if (entry.dueCountFailed) ...[
                    const SizedBox(height: AppSpacing.space4),
                    Text(
                      'flashcards.library.dueCountFailed'.tr(),
                      style: textTheme.bodySmall?.copyWith(color: colorScheme.error),
                    ),
                  ],
                ],
              ),
            ),
            const SizedBox(width: AppSpacing.space12),
            if (dueCount == null && !entry.dueCountFailed)
              const SizedBox(
                width: 20,
                height: 20,
                child: CircularProgressIndicator(strokeWidth: 2),
              )
            else
              FilledButton(
                onPressed: (dueCount ?? 0) > 0 ? onStudy : null,
                child: Text(
                  (dueCount ?? 0) > 0
                      ? 'flashcards.library.studyDue'.tr(namedArgs: {'count': '${dueCount ?? 0}'})
                      : 'flashcards.library.caughtUp'.tr(),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
