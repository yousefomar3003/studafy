import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/offline/offline_database.dart';
import 'package:studafy_mobile/src/features/ai/data/flashcard_library_store.dart';
import 'package:studafy_mobile/src/features/ai/domain/flashcard_deck_summary.dart';

void main() {
  late OfflineDatabase database;
  late FlashcardLibraryStore store;

  setUp(() {
    database = OfflineDatabase(NativeDatabase.memory());
    store = FlashcardLibraryStore(database);
  });

  tearDown(() => database.close());

  group('deck registry', () {
    test('loadDecks is empty for a student who has never generated a deck', () async {
      expect(await store.loadDecks('student-1'), isEmpty);
    });

    test('addDeck records the deck, most recent first', () async {
      final first = FlashcardDeckSummary(
        deckId: 'deck-1',
        generatedAt: DateTime(2026, 1, 1),
        cardCount: 10,
        materialTitles: const ['Biology Unit 3'],
      );
      final second = FlashcardDeckSummary(
        deckId: 'deck-2',
        generatedAt: DateTime(2026, 1, 2),
        cardCount: 5,
        materialTitles: const ['Chemistry Unit 1'],
      );

      await store.addDeck('student-1', first);
      await store.addDeck('student-1', second);

      final decks = await store.loadDecks('student-1');
      expect(decks.map((d) => d.deckId), ['deck-2', 'deck-1']);
    });

    test('keeps decks scoped to the student that generated them', () async {
      await store.addDeck(
        'student-1',
        FlashcardDeckSummary(
          deckId: 'deck-1',
          generatedAt: DateTime(2026, 1, 1),
          cardCount: 10,
          materialTitles: const [],
        ),
      );

      expect(await store.loadDecks('student-2'), isEmpty);
    });
  });

  group('review streak', () {
    test('starts at zero before any review is recorded', () async {
      expect(await store.loadStreak('student-1'), 0);
    });

    test('recordReviewToday raises the streak to one on the first review', () async {
      final streak = await store.recordReviewToday('student-1');
      expect(streak, 1);
      expect(await store.loadStreak('student-1'), 1);
    });

    test('recording twice in the same day does not double-count the streak', () async {
      await store.recordReviewToday('student-1');
      final streak = await store.recordReviewToday('student-1');
      expect(streak, 1);
    });

    test('streaks are scoped per student', () async {
      await store.recordReviewToday('student-1');
      expect(await store.loadStreak('student-2'), 0);
    });
  });
}
