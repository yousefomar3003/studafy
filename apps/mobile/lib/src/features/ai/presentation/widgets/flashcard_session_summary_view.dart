import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../domain/flashcard.dart';
import '../../domain/flashcard_state.dart';

/// A finished session's recap: how many cards were reviewed, broken down by rating. No score is
/// shown — flashcards are self-graded, not correct/incorrect, so a percentage here would imply a
/// precision the ratings don't carry.
class FlashcardSessionSummaryView extends StatelessWidget {
  const FlashcardSessionSummaryView({required this.state, required this.onBackToLibrary, super.key});

  final FlashcardSessionComplete state;
  final VoidCallback onBackToLibrary;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;

    return ListView(
      padding: const EdgeInsets.all(AppSpacing.space16),
      children: [
        Icon(Icons.check_circle_outline, size: 48, color: colorScheme.primary),
        const SizedBox(height: AppSpacing.space12),
        Text(
          'flashcards.summary.reviewedCount'.tr(namedArgs: {'count': '${state.outcomes.length}'}),
          style: textTheme.titleLarge,
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: AppSpacing.space20),
        for (final rating in FlashcardRating.values)
          _RatingTally(rating: rating, count: state.countOf(rating)),
        const SizedBox(height: AppSpacing.space20),
        FilledButton(onPressed: onBackToLibrary, child: Text('flashcards.summary.backToDecks'.tr())),
      ],
    );
  }
}

class _RatingTally extends StatelessWidget {
  const _RatingTally({required this.rating, required this.count});

  final FlashcardRating rating;
  final int count;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.space4),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(_labelFor(rating), style: textTheme.bodyMedium),
          Text('$count', style: textTheme.bodyMedium),
        ],
      ),
    );
  }

  String _labelFor(FlashcardRating rating) => switch (rating) {
    FlashcardRating.again => 'flashcards.review.rating.again'.tr(),
    FlashcardRating.hard => 'flashcards.review.rating.hard'.tr(),
    FlashcardRating.good => 'flashcards.review.rating.good'.tr(),
    FlashcardRating.easy => 'flashcards.review.rating.easy'.tr(),
  };
}
