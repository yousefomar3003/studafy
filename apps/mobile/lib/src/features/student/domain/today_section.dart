import '../../../core/offline/cached_value.dart';

/// The outcome of loading one card on the today screen, once loading itself has finished (a
/// provider's [AsyncValue.isLoading] covers the "still loading" half — this covers the rest).
///
/// [TodaySectionReady] carries real, possibly-stale data exactly like every other offline-aware
/// screen in this app (see [CachedValue.isStale]). [TodaySectionUnavailable] is a distinct third
/// state, not an error: some cards depend on session context this app cannot resolve yet (see
/// `student_context_providers.dart`'s doc comment) — that is a known gap, not a failed fetch, and
/// the card should say so plainly rather than showing a skeleton forever or a misleading error.
sealed class TodaySection<T> {
  const TodaySection();
}

class TodaySectionReady<T> extends TodaySection<T> {
  const TodaySectionReady(this.value);

  final CachedValue<T> value;
}

class TodaySectionUnavailable<T> extends TodaySection<T> {
  const TodaySectionUnavailable();
}
