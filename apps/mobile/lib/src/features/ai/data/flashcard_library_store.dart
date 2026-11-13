import 'dart:convert';

import '../../../core/offline/offline_database.dart';
import '../domain/flashcard_deck_summary.dart';
import '../domain/flashcard_streak.dart';

/// The [OfflineDatabase] cache-entry namespaces this store writes into, one row per student.
const _decksResource = 'flashcard_decks';
const _reviewedDaysResource = 'flashcard_reviewed_days';

/// Caps how many decks the browser remembers per student, oldest dropped first — a device that
/// generates decks forever shouldn't grow this table without bound. Well above what a student
/// would realistically keep open at once.
const _maxTrackedDecks = 50;

/// Caps how many days of review history are kept, oldest dropped first. [computeStreak] only ever
/// needs a short unbroken run ending at today, so a year is generous headroom, not a real limit on
/// how long a streak can run.
const _maxTrackedDays = 365;

/// Local-only state for the flashcard feature, keyed by student: the deck browser's registry
/// (there is no server endpoint that lists a student's decks — see [FlashcardDeckSummary]'s doc
/// comment) and the review-day log [computeStreak] runs on (there is no server concept of a
/// streak at all).
///
/// Both are genuinely local, not a cache of something re-fetchable — losing this data loses the
/// deck browser's history and resets the streak, unlike `MaterialsOfflineRepository`'s cache,
/// which a lost row just re-fetches. Same posture `QuizProgressStore` documents.
class FlashcardLibraryStore {
  FlashcardLibraryStore(this._database);

  final OfflineDatabase _database;

  Future<List<FlashcardDeckSummary>> loadDecks(String studentId) async {
    final row = await _database.read(resource: _decksResource, cacheKey: studentId);
    if (row == null) return const [];
    final decoded = jsonDecode(row.payload) as List<Object?>;
    return decoded
        .map((entry) => FlashcardDeckSummary.fromJson(entry! as Map<String, Object?>))
        .toList();
  }

  /// Records a newly generated deck, most recent first. Called once, right after
  /// `FlashcardClient.generateDeck` returns.
  Future<List<FlashcardDeckSummary>> addDeck(String studentId, FlashcardDeckSummary deck) async {
    final decks = [deck, ...await loadDecks(studentId)].take(_maxTrackedDecks).toList();
    await _database.write(
      resource: _decksResource,
      cacheKey: studentId,
      payload: jsonEncode(decks.map((entry) => entry.toJson()).toList()),
      fetchedAt: DateTime.now().toUtc(),
    );
    return decks;
  }

  Future<Set<DateTime>> _loadReviewedDays(String studentId) async {
    final row = await _database.read(resource: _reviewedDaysResource, cacheKey: studentId);
    if (row == null) return const {};
    final decoded = jsonDecode(row.payload) as List<Object?>;
    return decoded.map((iso) => DateTime.parse(iso! as String)).toSet();
  }

  /// The student's current review streak — consecutive days, ending today or yesterday, with at
  /// least one synced review. Pure read; does not itself count as "reviewed today".
  Future<int> loadStreak(String studentId) async {
    final days = await _loadReviewedDays(studentId);
    return computeStreak(days, today: DateTime.now());
  }

  /// Marks today as a reviewed day and returns the resulting streak. Called once per successfully
  /// synced rating — idempotent within a day, since [_loadReviewedDays] is a set.
  Future<int> recordReviewToday(String studentId) async {
    final now = DateTime.now();
    final days = {...await _loadReviewedDays(studentId), dateOnly(now)};
    final trimmed = days.toList()..sort((a, b) => b.compareTo(a));
    final bounded = trimmed.take(_maxTrackedDays).toSet();
    await _database.write(
      resource: _reviewedDaysResource,
      cacheKey: studentId,
      payload: jsonEncode(bounded.map((day) => day.toIso8601String()).toList()),
      fetchedAt: now.toUtc(),
    );
    return computeStreak(bounded, today: now);
  }
}
