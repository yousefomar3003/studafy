import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../domain/flashcard.dart';
import '../../domain/flashcard_state.dart';
import 'flashcard_citation_chip.dart';

/// How far (in logical pixels) a horizontal drag has to travel before it counts as a swipe rating
/// rather than a drag that snaps back.
const _swipeAcceptThreshold = 96.0;

/// One review card: tap (or the "Show answer" button) flips it, then rate with the button row or a
/// left/right swipe once flipped.
///
/// Swipe is a shortcut for the two most common ratings, never the only way to give any of them:
/// left = again, right = good, and all four ratings — including `hard` and `easy`, which have no
/// swipe direction of their own — are always reachable from the button row below. That split is
/// what makes "gestures have accessible alternatives" true here: a screen-reader or switch-access
/// user gets the complete rating scale from four ordinary, individually labeled buttons, never
/// needing the drag gesture at all.
class FlashcardReviewCard extends StatelessWidget {
  const FlashcardReviewCard({
    required this.session,
    required this.onReveal,
    required this.onRate,
    required this.onRetrySync,
    super.key,
  });

  final FlashcardReviewSession session;
  final VoidCallback onReveal;
  final ValueChanged<FlashcardRating> onRate;
  final VoidCallback onRetrySync;

  @override
  Widget build(BuildContext context) {
    final card = session.currentCard;
    if (card == null) return const SizedBox.shrink();
    final colorScheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;

    return Padding(
      padding: const EdgeInsets.all(AppSpacing.space16),
      child: Column(
        children: [
          Text(
            'flashcards.review.progress'.tr(
              namedArgs: {
                'position': '${session.currentIndex + 1}',
                'total': '${session.cards.length}',
              },
            ),
            style: textTheme.labelMedium?.copyWith(color: colorScheme.onSurfaceVariant),
          ),
          const SizedBox(height: AppSpacing.space16),
          Expanded(
            child: _SwipeableFace(
              key: ValueKey(card.id),
              card: card,
              revealed: session.revealed,
              onReveal: onReveal,
              onSwipeRate: session.isSubmitting ? null : onRate,
            ),
          ),
          const SizedBox(height: AppSpacing.space16),
          if (session.syncFailedRating != null) ...[
            _SyncFailedBanner(onRetry: onRetrySync),
            const SizedBox(height: AppSpacing.space8),
          ],
          if (!session.revealed)
            FilledButton(
              onPressed: onReveal,
              child: Text('flashcards.review.showAnswer'.tr()),
            )
          else
            _RatingButtonRow(isSubmitting: session.isSubmitting, onRate: onRate),
        ],
      ),
    );
  }
}

class _SwipeableFace extends StatefulWidget {
  const _SwipeableFace({
    required this.card,
    required this.revealed,
    required this.onReveal,
    required this.onSwipeRate,
    super.key,
  });

  final FlashcardCard card;
  final bool revealed;
  final VoidCallback onReveal;
  final ValueChanged<FlashcardRating>? onSwipeRate;

  @override
  State<_SwipeableFace> createState() => _SwipeableFaceState();
}

class _SwipeableFaceState extends State<_SwipeableFace> {
  double _dragDx = 0;

  void _onDragEnd(DragEndDetails details) {
    final onSwipeRate = widget.onSwipeRate;
    if (onSwipeRate != null && _dragDx.abs() >= _swipeAcceptThreshold) {
      onSwipeRate(_dragDx > 0 ? FlashcardRating.good : FlashcardRating.again);
    }
    setState(() => _dragDx = 0);
  }

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final canSwipe = widget.revealed && widget.onSwipeRate != null;
    final tint = !canSwipe || _dragDx == 0
        ? null
        : (_dragDx > 0 ? Colors.green : Colors.red).withValues(
            alpha: (_dragDx.abs() / (_swipeAcceptThreshold * 2)).clamp(0.0, 0.25).toDouble(),
          );

    return GestureDetector(
      onHorizontalDragUpdate: canSwipe ? (d) => setState(() => _dragDx += d.delta.dx) : null,
      onHorizontalDragEnd: canSwipe ? _onDragEnd : null,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 150),
        transform: Matrix4.translationValues(_dragDx, 0, 0),
        child: Semantics(
          button: true,
          label: widget.card.front,
          value: widget.revealed ? widget.card.back : null,
          hint: widget.revealed ? null : 'flashcards.review.flipHint'.tr(),
          onTap: widget.revealed ? null : widget.onReveal,
          child: Material(
            color: tint == null
                ? colorScheme.surfaceContainerHighest
                : Color.alphaBlend(tint, colorScheme.surfaceContainerHighest),
            borderRadius: BorderRadius.circular(16),
            child: InkWell(
              borderRadius: BorderRadius.circular(16),
              onTap: widget.revealed ? null : widget.onReveal,
              child: Padding(
                padding: const EdgeInsets.all(AppSpacing.space24),
                child: SingleChildScrollView(
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      ExcludeSemantics(
                        child: Text(widget.card.front, style: Theme.of(context).textTheme.headlineSmall),
                      ),
                      if (widget.revealed) ...[
                        const SizedBox(height: AppSpacing.space16),
                        const Divider(),
                        const SizedBox(height: AppSpacing.space16),
                        ExcludeSemantics(
                          child: Text(widget.card.back, style: Theme.of(context).textTheme.bodyLarge),
                        ),
                        const SizedBox(height: AppSpacing.space12),
                        FlashcardCitationChip(citation: widget.card.citation),
                      ],
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _RatingButtonRow extends StatelessWidget {
  const _RatingButtonRow({required this.isSubmitting, required this.onRate});

  final bool isSubmitting;
  final ValueChanged<FlashcardRating> onRate;

  @override
  Widget build(BuildContext context) {
    if (isSubmitting) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: AppSpacing.space12),
        child: CircularProgressIndicator(strokeWidth: 2),
      );
    }

    return Row(
      children: [
        for (final rating in FlashcardRating.values) ...[
          if (rating != FlashcardRating.values.first) const SizedBox(width: AppSpacing.space8),
          Expanded(
            child: OutlinedButton(
              onPressed: () => onRate(rating),
              style: OutlinedButton.styleFrom(
                foregroundColor: _colorFor(context, rating),
                side: BorderSide(color: _colorFor(context, rating)),
              ),
              child: Text(_labelFor(rating)),
            ),
          ),
        ],
      ],
    );
  }

  String _labelFor(FlashcardRating rating) => switch (rating) {
    FlashcardRating.again => 'flashcards.review.rating.again'.tr(),
    FlashcardRating.hard => 'flashcards.review.rating.hard'.tr(),
    FlashcardRating.good => 'flashcards.review.rating.good'.tr(),
    FlashcardRating.easy => 'flashcards.review.rating.easy'.tr(),
  };

  Color _colorFor(BuildContext context, FlashcardRating rating) {
    final colorScheme = Theme.of(context).colorScheme;
    return switch (rating) {
      FlashcardRating.again => colorScheme.error,
      FlashcardRating.hard => Colors.orange,
      FlashcardRating.good => colorScheme.primary,
      FlashcardRating.easy => Colors.green,
    };
  }
}

class _SyncFailedBanner extends StatelessWidget {
  const _SyncFailedBanner({required this.onRetry});

  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(AppSpacing.space12),
      decoration: BoxDecoration(color: colorScheme.errorContainer, borderRadius: BorderRadius.circular(8)),
      child: Row(
        children: [
          Icon(Icons.error_outline, size: 18, color: colorScheme.onErrorContainer),
          const SizedBox(width: AppSpacing.space8),
          Expanded(
            child: Text(
              'flashcards.review.syncFailed'.tr(),
              style: TextStyle(color: colorScheme.onErrorContainer),
            ),
          ),
          TextButton(onPressed: onRetry, child: Text('flashcards.review.retry'.tr())),
        ],
      ),
    );
  }
}
