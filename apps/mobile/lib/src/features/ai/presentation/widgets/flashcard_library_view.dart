import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../domain/flashcard_state.dart';
import 'flashcard_deck_tile.dart';

/// The deck browser: every deck this device has generated, each with its due-today count, below a
/// pull-to-refresh that re-checks every deck's due count against the server.
class FlashcardLibraryView extends StatelessWidget {
  const FlashcardLibraryView({
    required this.state,
    required this.onRefresh,
    required this.onStudy,
    super.key,
  });

  final FlashcardLibrary state;
  final Future<void> Function() onRefresh;
  final ValueChanged<String> onStudy;

  @override
  Widget build(BuildContext context) {
    if (state.decks.isEmpty) {
      return RefreshIndicator(
        onRefresh: onRefresh,
        child: LayoutBuilder(
          builder: (context, constraints) => SingleChildScrollView(
            physics: const AlwaysScrollableScrollPhysics(),
            child: ConstrainedBox(
              constraints: BoxConstraints(minHeight: constraints.maxHeight),
              child: const _EmptyLibrary(),
            ),
          ),
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: onRefresh,
      child: ListView.builder(
        padding: const EdgeInsets.all(AppSpacing.space16),
        itemCount: state.decks.length,
        itemBuilder: (context, index) {
          final entry = state.decks[index];
          return FlashcardDeckTile(entry: entry, onStudy: () => onStudy(entry.summary.deckId));
        },
      ),
    );
  }
}

class _EmptyLibrary extends StatelessWidget {
  const _EmptyLibrary();

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.style_outlined, size: 32, color: colorScheme.onSurfaceVariant),
            const SizedBox(height: AppSpacing.space12),
            Text(
              'flashcards.library.empty'.tr(),
              textAlign: TextAlign.center,
              style: TextStyle(color: colorScheme.onSurfaceVariant),
            ),
          ],
        ),
      ),
    );
  }
}
