import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/generated/models/announcement.dart';
import '../../../core/api/generated/models/assignment.dart';
import '../../../core/api/generated/models/published_grade_snapshot.dart';
import '../../../core/api/generated/models/status11.dart';
import '../../../core/api/generated/models/timetable_slot.dart';
import '../../../core/auth/auth_providers.dart';
import '../../../core/offline/cached_value.dart';
import '../../../core/offline/offline_providers.dart';
import '../../../core/realtime/realtime_providers.dart';
import '../domain/today_section.dart';
import 'current_term_provider.dart';
import 'student_context_providers.dart';

/// Due-soon assignments — nearest deadline first, offline-aware. Self-scoped by the API (see
/// `AssignmentsOfflineRepository`'s doc comment), so unlike the grades and timetable cards this
/// needs no session context to resolve.
final todayAssignmentsProvider = StreamProvider.autoDispose<CachedValue<List<Assignment>>>((ref) {
  return ref.watch(assignmentsOfflineRepositoryProvider).dueSoon();
});

/// The newest announcements, offline-aware. Same self-scoping note as
/// [todayAssignmentsProvider] — the server resolves audience visibility, so this is a direct
/// pass-through of the existing feed.
final todayAnnouncementsProvider = StreamProvider.autoDispose<CachedValue<List<Announcement>>>((
  ref,
) {
  return ref.watch(announcementsOfflineRepositoryProvider).feed();
});

/// Newly published grades for the current term. [TodaySectionUnavailable] when
/// [currentStudentIdProvider] hasn't resolved — see that provider's doc comment for why.
///
/// Re-fetches live: a `grades.published` realtime event naming this student invalidates the
/// provider, so a grade published while this screen is open appears without the student having
/// to leave and come back. See `core/realtime/realtime_providers.dart`'s doc comment for the
/// general pattern this follows, and `apps/realtime/src/event-routing.ts` for why filtering by
/// the payload's own `studentId` (rather than reacting to every `grades.published` on the
/// STUDENT role room) is the correct behavior, not an optional nicety.
final todayGradesProvider = StreamProvider.autoDispose<TodaySection<PublishedGradeSnapshot>>((
  ref,
) async* {
  final studentId = ref.watch(currentStudentIdProvider);
  if (studentId == null) {
    yield const TodaySectionUnavailable();
    return;
  }

  ref.listen(realtimeEventsProvider, (previous, next) {
    final envelope = next.value;
    if (envelope?.type != 'grades.published') return;
    final payload = envelope!.payload;
    if (payload is Map && payload['studentId'] == studentId) {
      ref.invalidateSelf();
    }
  });

  final term = await ref.watch(currentTermProvider.future);
  final repo = ref.watch(publishedGradesOfflineRepositoryProvider);

  yield* repo
      .snapshotFor(studentId: studentId, termId: term.id)
      .map((cached) => TodaySectionReady(cached));
});

/// Today's timetable slots, nearest period first. [TodaySectionUnavailable] when
/// [currentEnrolledClassIdsProvider] hasn't resolved, or when the current term has no approved
/// timetable version yet — both are legitimate "nothing to show" states, not errors.
final todayTimetableProvider = StreamProvider.autoDispose<TodaySection<List<TimetableSlot>>>((
  ref,
) async* {
  final classIds = ref.watch(currentEnrolledClassIdsProvider);
  if (classIds.isEmpty) {
    yield const TodaySectionUnavailable();
    return;
  }

  final term = await ref.watch(currentTermProvider.future);
  final api = ref.watch(apiClientProvider);
  final versions = await api.timetable.listTimetableVersions(
    termId: term.id,
    status: Status11.approved,
    limit: 1,
  );
  if (versions.timetableVersions.isEmpty) {
    yield const TodaySectionUnavailable();
    return;
  }
  final version = versions.timetableVersions.first;

  final repo = ref.watch(timetableOfflineRepositoryProvider);
  final today = DateTime.now().weekday;
  final classIdSet = classIds.toSet();

  yield* repo.slotsForVersion(version.id).map((cached) {
    final todaysSlots = cached.data
        .where((slot) => slot.weekday == today && classIdSet.contains(slot.classId))
        .toList()
      ..sort((a, b) => a.period.compareTo(b.period));
    return TodaySectionReady(
      CachedValue(data: todaysSlots, fetchedAt: cached.fetchedAt, source: cached.source),
    );
  });
});
