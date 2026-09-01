import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../application/ask_ai_providers.dart';
import '../application/flashcard_controller.dart';
import '../application/flashcard_providers.dart';
import '../domain/flashcard_state.dart';
import 'widgets/flashcard_generate_sheet.dart';
import 'widgets/flashcard_library_view.dart';
import 'widgets/flashcard_review_card.dart';
import 'widgets/flashcard_session_summary_view.dart';
import 'widgets/flashcard_streak_badge.dart';

/// Flashcards: browse generated decks with their due-today counts and review streak, generate new
/// decks from study materials, and review a deck's due cards one at a time — flip, then grade with
/// a swipe or the button row, each rating synced to the server immediately.
///
/// Route-only (`/me/flashcards`), like Quiz and Ask AI. Reuses [askAiStudentIdProvider] — every
/// `/api/ai/*` route takes the same `{studentId}` path convention (the session's own user id).
class FlashcardsScreen extends ConsumerStatefulWidget {
  const FlashcardsScreen({super.key});

  @override
  ConsumerState<FlashcardsScreen> createState() => _FlashcardsScreenState();
}

class _FlashcardsScreenState extends ConsumerState<FlashcardsScreen> {
  FlashcardController? _controller;

  @override
  void initState() {
    super.initState();
    final studentId = ref.read(askAiStudentIdProvider);
    if (studentId != null) {
      final controller = FlashcardController(
        client: ref.read(flashcardClientProvider),
        libraryStore: ref.read(flashcardLibraryStoreProvider),
        studentId: studentId,
      )..addListener(_onChange);
      _controller = controller;
      controller.restore();
    }
  }

  void _onChange() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    _controller?.removeListener(_onChange);
    _controller?.dispose();
    super.dispose();
  }

  Future<void> _openGenerateSheet(FlashcardController controller) async {
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (sheetContext) => AnimatedBuilder(
        animation: controller,
        builder: (sheetContext, _) {
          final state = controller.state;
          final isGenerating = state is FlashcardLibrary && state.isGenerating;
          final generateError = state is FlashcardLibrary ? state.generateError : null;
          return FlashcardGenerateSheet(
            isGenerating: isGenerating,
            generateError: generateError,
            onGenerate: (materialIds, materialTitles, cardCount) async {
              await controller.generateDeck(
                materialIds: materialIds,
                materialTitles: materialTitles,
                cardCount: cardCount,
              );
              if (controller.state is! FlashcardLibrary && sheetContext.mounted) {
                Navigator.of(sheetContext).pop();
              }
            },
          );
        },
      ),
    );
  }

  Future<void> _study(FlashcardController controller, String deckId) async {
    final started = await controller.startSession(deckId);
    if (!started && mounted) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text('flashcards.library.studyError'.tr())));
    }
  }

  @override
  Widget build(BuildContext context) {
    final controller = _controller;

    return Scaffold(
      appBar: AppBar(
        title: Text('flashcards.title'.tr()),
        actions: [
          Builder(
            builder: (context) {
              final libraryState = controller?.state;
              if (libraryState is! FlashcardLibrary) return const SizedBox.shrink();
              return Padding(
                padding: const EdgeInsets.only(right: 16),
                child: Center(child: FlashcardStreakBadge(streak: libraryState.streak)),
              );
            },
          ),
        ],
      ),
      floatingActionButton: switch (controller?.state) {
        FlashcardLibrary() => FloatingActionButton.extended(
          onPressed: () => _openGenerateSheet(controller!),
          icon: const Icon(Icons.add),
          label: Text('flashcards.library.generate'.tr()),
        ),
        _ => null,
      },
      body: controller == null ? const _SignedOutNotice() : _Body(controller: controller, onStudy: _study),
    );
  }
}

class _Body extends StatelessWidget {
  const _Body({required this.controller, required this.onStudy});

  final FlashcardController controller;
  final Future<void> Function(FlashcardController controller, String deckId) onStudy;

  @override
  Widget build(BuildContext context) {
    final state = controller.state;

    return switch (state) {
      FlashcardLibrary() => FlashcardLibraryView(
        state: state,
        onRefresh: controller.refreshDueCounts,
        onStudy: (deckId) => onStudy(controller, deckId),
      ),
      FlashcardReviewSession() => state.cards.isEmpty
          ? _NothingDue(onBack: controller.backToLibrary)
          : Column(
              children: [
                Align(
                  alignment: AlignmentDirectional.centerStart,
                  child: IconButton(
                    onPressed: controller.backToLibrary,
                    icon: const Icon(Icons.arrow_back),
                    tooltip: 'flashcards.review.backToDecks'.tr(),
                  ),
                ),
                Expanded(
                  child: FlashcardReviewCard(
                    session: state,
                    onReveal: controller.revealAnswer,
                    onRate: controller.rate,
                    onRetrySync: controller.retrySync,
                  ),
                ),
              ],
            ),
      FlashcardSessionComplete() => FlashcardSessionSummaryView(
        state: state,
        onBackToLibrary: controller.backToLibrary,
      ),
    };
  }
}

class _NothingDue extends StatelessWidget {
  const _NothingDue({required this.onBack});

  final VoidCallback onBack;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.check_circle_outline, size: 32, color: colorScheme.primary),
            const SizedBox(height: 12),
            Text(
              'flashcards.review.nothingDue'.tr(),
              textAlign: TextAlign.center,
              style: TextStyle(color: colorScheme.onSurfaceVariant),
            ),
            const SizedBox(height: 16),
            FilledButton(onPressed: onBack, child: Text('flashcards.review.backToDecks'.tr())),
          ],
        ),
      ),
    );
  }
}

class _SignedOutNotice extends StatelessWidget {
  const _SignedOutNotice();

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.lock_outline, size: 32, color: colorScheme.onSurfaceVariant),
            const SizedBox(height: 12),
            Text(
              'flashcards.signedOut'.tr(),
              textAlign: TextAlign.center,
              style: TextStyle(color: colorScheme.onSurfaceVariant),
            ),
          ],
        ),
      ),
    );
  }
}
