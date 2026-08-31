import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/generated/models/exam.dart';
import '../../../core/auth/auth_providers.dart';
import '../../../core/offline/cached_value.dart';
import '../../../core/offline/offline_providers.dart';
import '../domain/upcoming_exams.dart';
import 'student_context_providers.dart';

/// Offline-cached exams for the student's enrolled classes — newest-first from the server and
/// reconciled against the cache (see `ExamsOfflineRepository`). Empty (and never fetched) when
/// the enrolment set is unresolved: the screen is [ExamsAgendaUnavailable] in that case anyway.
///
/// Mirrors `timetable_providers.dart`'s `weekExamsProvider`, which feeds the timetable's exam
/// overlay from the same repository; kept as its own provider so the two screens don't import
/// each other's application layer.
final enrolledClassExamsProvider = StreamProvider.autoDispose<CachedValue<List<Exam>>>((ref) {
  final classIds = ref.watch(currentEnrolledClassIdsProvider);
  if (classIds.isEmpty) {
    return Stream.value(
      CachedValue(
        data: const <Exam>[],
        fetchedAt: DateTime.now().toUtc(),
        source: CacheSource.network,
      ),
    );
  }
  return ref.watch(examsOfflineRepositoryProvider).examsForClasses(classIds);
});

/// Room code by room id, indexed from the one room-directory list call the screen needs. `GET
/// /api/academics/rooms` has no by-id form, so this fetches the (small) directory once. Mirrors
/// `timetable_day_section.dart`'s private `_roomCodesProvider`.
final examRoomDirectoryProvider = FutureProvider.autoDispose<Map<String, String>>((ref) async {
  final page = await ref.watch(apiClientProvider).academics.listRooms(limit: 200);
  return {for (final room in page.rooms) room.id: room.code};
});

/// The upcoming-exams agenda for the exams screen: the enrolled classes' cached exams grouped
/// into calendar days, with staleness carried through from the cache.
///
/// A plain [Provider] of [AsyncValue] rather than a generator, the same shape and for the same
/// reason as `timetableWeekProvider`: it folds the [currentEnrolledClassIdsProvider] gate and a
/// pure assembler over one async source, which is simpler to read and to override in tests than
/// a stream transformer.
final examsAgendaProvider = Provider.autoDispose<AsyncValue<ExamsAgendaStatus>>((ref) {
  final classIds = ref.watch(currentEnrolledClassIdsProvider);
  if (classIds.isEmpty) {
    return const AsyncData<ExamsAgendaStatus>(ExamsAgendaUnavailable());
  }

  final examsAsync = ref.watch(enrolledClassExamsProvider);
  return examsAsync.when(
    loading: () => const AsyncLoading<ExamsAgendaStatus>(),
    error: (error, stackTrace) => AsyncError<ExamsAgendaStatus>(error, stackTrace),
    data: (cached) {
      final agenda = assembleExamsAgenda(exams: cached.data, now: DateTime.now());
      return AsyncData<ExamsAgendaStatus>(
        ExamsAgendaReady(
          CachedValue(data: agenda, fetchedAt: cached.fetchedAt, source: cached.source),
        ),
      );
    },
  );
});
