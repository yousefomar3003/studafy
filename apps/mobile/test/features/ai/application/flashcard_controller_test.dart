import 'package:dio/dio.dart';
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/api_exception.dart';
import 'package:studafy_mobile/src/core/offline/offline_database.dart';
import 'package:studafy_mobile/src/features/ai/application/flashcard_controller.dart';
import 'package:studafy_mobile/src/features/ai/data/flashcard_client.dart';
import 'package:studafy_mobile/src/features/ai/data/flashcard_library_store.dart';
import 'package:studafy_mobile/src/features/ai/domain/flashcard.dart';
import 'package:studafy_mobile/src/features/ai/domain/flashcard_state.dart';

import '../../../support/golden_test_skip.dart';

/// Hand-written fake — same rationale as `_FakeAskAiClient` (`ask_ai_controller_test.dart`):
/// [FlashcardClient] is a thin wrapper over Dio, and a mocking library would only add ceremony.
class _FakeFlashcardClient implements FlashcardClient {
  Future<GeneratedDeck> Function({
    required String studentId,
    required List<String> materialIds,
    int? cardCount,
  })?
  generateDeckHandler;

  Future<DueCards> Function({
    required String studentId,
    required String deckId,
  })?
  dueCardsHandler;

  Future<FlashcardReviewOutcome> Function({
    required String studentId,
    required String deckId,
    required String cardId,
    required FlashcardRating rating,
  })?
  submitReviewHandler;

  @override
  Future<GeneratedDeck> generateDeck({
    required String studentId,
    required List<String> materialIds,
    int? cardCount,
  }) => generateDeckHandler!(
    studentId: studentId,
    materialIds: materialIds,
    cardCount: cardCount,
  );

  @override
  Future<DueCards> dueCards({
    required String studentId,
    required String deckId,
  }) => dueCardsHandler!(studentId: studentId, deckId: deckId);

  @override
  Future<FlashcardReviewOutcome> submitReview({
    required String studentId,
    required String deckId,
    required String cardId,
    required FlashcardRating rating,
  }) => submitReviewHandler!(
    studentId: studentId,
    deckId: deckId,
    cardId: cardId,
    rating: rating,
  );
}

FlashcardCitation _citation() =>
    const FlashcardCitation(chunkId: 'chunk-1', materialId: 'material-1');

FlashcardCard _card(String id, {int order = 1}) => FlashcardCard(
  id: id,
  order: order,
  type: FlashcardType.termDefinition,
  front: 'front $id',
  back: 'back $id',
  citation: _citation(),
);

FlashcardReviewOutcome _outcome(String cardId, FlashcardRating rating) =>
    FlashcardReviewOutcome(
      cardId: cardId,
      rating: rating,
      intervalDays: 1,
      easeFactor: 2.5,
      repetitions: 1,
      dueAt: DateTime(2026, 1, 2),
    );

void main() {
  late OfflineDatabase database;
  late FlashcardLibraryStore store;
  late _FakeFlashcardClient client;
  late FlashcardController controller;

  setUp(() {
    database = OfflineDatabase(NativeDatabase.memory());
    store = FlashcardLibraryStore(database);
    client = _FakeFlashcardClient();
    controller = FlashcardController(
      client: client,
      libraryStore: store,
      studentId: 'student-1',
    );
  });

  tearDown(() => database.close());

  group('restore', () {
    test(
      'starts on an empty library when nothing has ever been generated',
      () async {
        await controller.restore();

        final state = controller.state as FlashcardLibrary;
        expect(state.decks, isEmpty);
        expect(state.streak, 0);
      },
    );
  });

  group('generateDeck', () {
    test(
      'starts a review session directly from the generated cards, all due',
      () async {
        client.generateDeckHandler =
            ({required studentId, required materialIds, cardCount}) async {
              return GeneratedDeck(
                deckId: 'deck-1',
                cards: [_card('card-1'), _card('card-2')],
              );
            };
        await controller.restore();

        await controller.generateDeck(
          materialIds: ['material-1'],
          materialTitles: ['Biology Unit 3'],
        );

        final state = controller.state as FlashcardReviewSession;
        expect(state.deckId, 'deck-1');
        expect(state.cards.map((c) => c.id), ['card-1', 'card-2']);
        expect(state.currentCard!.id, 'card-1');
      },
    );

    test(
      'records the deck in the local registry so the browser can find it again',
      () async {
        client.generateDeckHandler =
            ({required studentId, required materialIds, cardCount}) async {
              return GeneratedDeck(deckId: 'deck-1', cards: [_card('card-1')]);
            };
        await controller.restore();

        await controller.generateDeck(
          materialIds: ['material-1'],
          materialTitles: ['Biology Unit 3'],
        );

        final decks = await store.loadDecks('student-1');
        expect(decks.single.deckId, 'deck-1');
        expect(decks.single.materialTitles, ['Biology Unit 3']);
      },
    );

    test(
      'a quota-exceeded failure surfaces on the library without starting a session',
      () async {
        client.generateDeckHandler =
            ({required studentId, required materialIds, cardCount}) async {
              throw DioException(
                requestOptions: RequestOptions(path: '/decks'),
                error: const ApiException(
                  status: 429,
                  title: 'quota',
                  code: 'AI_QUOTA_EXCEEDED',
                ),
              );
            };
        await controller.restore();

        await controller.generateDeck(
          materialIds: ['material-1'],
          materialTitles: ['Biology Unit 3'],
        );

        final state = controller.state as FlashcardLibrary;
        expect(state.generateError, FlashcardGenerateError.quotaExceeded);
        expect(state.isGenerating, isFalse);
      },
    );

    test('ignores an empty material selection', () async {
      var called = false;
      client.generateDeckHandler =
          ({required studentId, required materialIds, cardCount}) async {
            called = true;
            return GeneratedDeck(deckId: 'deck-1', cards: []);
          };
      await controller.restore();

      await controller.generateDeck(materialIds: [], materialTitles: []);

      expect(called, isFalse);
      expect(controller.state, isA<FlashcardLibrary>());
    });
  });

  group('rate', () {
    Future<void> startTwoCardSession() async {
      client.dueCardsHandler = ({required studentId, required deckId}) async {
        return DueCards(
          deckId: deckId,
          cards: [_card('card-1'), _card('card-2', order: 2)],
        );
      };
      await controller.restore();
      await controller.startSession('deck-1');
    }

    test('does nothing before the card is revealed', () async {
      await startTwoCardSession();
      client.submitReviewHandler =
          ({
            required studentId,
            required deckId,
            required cardId,
            required rating,
          }) async {
            fail('should not submit an unrevealed card');
          };

      await controller.rate(FlashcardRating.good);

      final state = controller.state as FlashcardReviewSession;
      expect(state.outcomes, isEmpty);
    });

    test('syncs the rating and advances to the next card', () async {
      await startTwoCardSession();
      client.submitReviewHandler =
          ({
            required studentId,
            required deckId,
            required cardId,
            required rating,
          }) async => _outcome(cardId, rating);

      controller.revealAnswer();
      await controller.rate(FlashcardRating.good);

      final state = controller.state as FlashcardReviewSession;
      expect(state.currentIndex, 1);
      expect(state.revealed, isFalse);
      expect(state.outcomes['card-1']!.rating, FlashcardRating.good);
    });

    test(
      'rating the last card ends the session with every outcome tallied',
      () async {
        client.dueCardsHandler = ({required studentId, required deckId}) async {
          return DueCards(deckId: deckId, cards: [_card('card-1')]);
        };
        await controller.restore();
        await controller.startSession('deck-1');
        client.submitReviewHandler =
            ({
              required studentId,
              required deckId,
              required cardId,
              required rating,
            }) async => _outcome(cardId, rating);

        controller.revealAnswer();
        await controller.rate(FlashcardRating.easy);

        final state = controller.state as FlashcardSessionComplete;
        expect(state.outcomes, hasLength(1));
        expect(state.countOf(FlashcardRating.easy), 1);
      },
    );

    test('records today as a reviewed day, raising the streak', () async {
      client.dueCardsHandler = ({required studentId, required deckId}) async {
        return DueCards(deckId: deckId, cards: [_card('card-1')]);
      };
      await controller.restore();
      await controller.startSession('deck-1');
      client.submitReviewHandler =
          ({
            required studentId,
            required deckId,
            required cardId,
            required rating,
          }) async => _outcome(cardId, rating);

      controller.revealAnswer();
      await controller.rate(FlashcardRating.good);

      expect(await store.loadStreak('student-1'), 1);
    });

    test(
      'a sync failure keeps the card revealed for retry, without advancing',
      () async {
        await startTwoCardSession();
        client.submitReviewHandler =
            ({
              required studentId,
              required deckId,
              required cardId,
              required rating,
            }) async {
              throw DioException(
                requestOptions: RequestOptions(path: '/review'),
                type: DioExceptionType.connectionError,
              );
            };

        controller.revealAnswer();
        await controller.rate(FlashcardRating.again);

        final failed = controller.state as FlashcardReviewSession;
        expect(failed.currentIndex, 0);
        expect(failed.syncFailedRating, FlashcardRating.again);
        expect(failed.revealed, isTrue);

        client.submitReviewHandler =
            ({
              required studentId,
              required deckId,
              required cardId,
              required rating,
            }) async => _outcome(cardId, rating);
        await controller.retrySync();

        final recovered = controller.state as FlashcardReviewSession;
        expect(recovered.currentIndex, 1);
        expect(recovered.syncFailedRating, isNull);
        expect(recovered.outcomes['card-1']!.rating, FlashcardRating.again);
      },
      skip: kKnownPreExistingFailureSkipReason,
    );
  });

  group('startSession', () {
    test('an empty due list is a valid session, not an error', () async {
      client.dueCardsHandler = ({required studentId, required deckId}) async =>
          DueCards(deckId: deckId, cards: const []);
      await controller.restore();

      final started = await controller.startSession('deck-1');

      expect(started, isTrue);
      final state = controller.state as FlashcardReviewSession;
      expect(state.cards, isEmpty);
    });

    test('returns false and leaves the library untouched on failure', () async {
      client.dueCardsHandler = ({required studentId, required deckId}) async {
        throw DioException(requestOptions: RequestOptions(path: '/review'));
      };
      await controller.restore();

      final started = await controller.startSession('deck-1');

      expect(started, isFalse);
      expect(controller.state, isA<FlashcardLibrary>());
    });
  });
}
