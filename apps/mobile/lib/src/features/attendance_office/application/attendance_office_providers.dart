import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/auth_interceptor.dart';
import '../../../core/api/error_mapping_interceptor.dart';
import '../../../core/api/generated/models/attendance_record.dart';
import '../../../core/api/generated/models/attendance_session.dart';
import '../../../core/api/generated/models/class.dart';
import '../../../core/api/generated/models/class_status.dart';
import '../../../core/auth/auth_providers.dart';
import '../../../core/di/app_providers.dart';
import '../data/attendance_office_client.dart';
import '../domain/attendance_office.dart';

/// [AttendanceOfficeClient] on its own [Dio], wired identically to `createApiClient` — same base
/// URL, bearer injection (with 401 recovery) and [ErrorMappingInterceptor].
final attendanceOfficeClientProvider = Provider<AttendanceOfficeClient>((ref) {
  final baseUrl = ref.watch(networkConfigProvider).apiBaseUrl;
  final session = ref.watch(authSessionProvider);
  final dio = Dio(BaseOptions(baseUrl: baseUrl.toString()));
  dio.interceptors
    ..add(
      AuthInterceptor(
        () => session.tokenProvider,
        onUnauthorized: () =>
            ref.read(authNotifierProvider.notifier).handleAuthFailure(),
        onSchoolClosed: () =>
            ref.read(authNotifierProvider.notifier).handleSchoolClosed(),
        retryClient: dio,
      ),
    )
    ..add(ErrorMappingInterceptor());
  return AttendanceOfficeClient(dio);
});

// ---------------------------------------------------------------------------
// Date + term the Registers tab is looking at
// ---------------------------------------------------------------------------

/// The register date, today by default. Only past days and today are selectable.
class RegisterDateNotifier extends Notifier<DateTime> {
  @override
  DateTime build() => dateOnly(DateTime.now());

  void select(DateTime date) => state = dateOnly(date);
}

final registerDateProvider = NotifierProvider<RegisterDateNotifier, DateTime>(
  RegisterDateNotifier.new,
);

/// A term the user picked over the auto-selected one; null follows [pickCurrentTerm].
class PickedTermNotifier extends Notifier<String?> {
  @override
  String? build() => null;

  void select(String termId) => state = termId;
}

final pickedTermIdProvider = NotifierProvider<PickedTermNotifier, String?>(
  PickedTermNotifier.new,
);

/// The current academic year's terms and the term in view: the user's pick, else the term
/// containing today (else the next, else the last) — the web `useTermSelection` rule.
final officeTermSelectionProvider = FutureProvider<TermSelection>((ref) async {
  ref.watch(authStatusProvider);
  final client = ref.watch(attendanceOfficeClientProvider);
  final year = pickCurrentYear(await client.listAcademicYears());
  if (year == null) return const TermSelection(terms: [], term: null);

  final terms = (await client.listTerms(year.id))
    ..sort((a, b) => a.startsOn.compareTo(b.startsOn));
  final pickedId = ref.watch(pickedTermIdProvider);
  final picked = terms.where((term) => term.id == pickedId).firstOrNull;
  return TermSelection(
    terms: terms,
    term: picked ?? pickCurrentTerm(terms, DateTime.now()),
  );
});

// ---------------------------------------------------------------------------
// Registers list
// ---------------------------------------------------------------------------

/// Every daily register opened in the school on a date, keyed by class id.
final dailySessionsProvider =
    FutureProvider.family<Map<String, AttendanceSession>, DateTime>((
      ref,
      date,
    ) {
      return ref.watch(attendanceOfficeClientProvider).listDailySessions(date);
    });

/// Every non-cancelled class in [termId], by code.
final officeClassesProvider = FutureProvider.family<List<Class>, String>((
  ref,
  termId,
) async {
  final classes = await ref
      .watch(attendanceOfficeClientProvider)
      .listClasses(termId);
  return classes.where((c) => c.status != ClassStatus.cancelled).toList()
    ..sort((a, b) => a.code.compareTo(b.code));
});

/// One row per class in the term in view, with its register state on the chosen date. Empty when
/// the school has no year/term set up yet.
final officeRegistersProvider = FutureProvider<List<ClassRegisterSummary>>((
  ref,
) async {
  final date = ref.watch(registerDateProvider);
  final selection = await ref.watch(officeTermSelectionProvider.future);
  final term = selection.term;
  if (term == null) return const [];

  final classesFuture = ref.watch(officeClassesProvider(term.id).future);
  final sessionsFuture = ref.watch(dailySessionsProvider(date).future);
  final classes = await classesFuture;
  final sessions = await sessionsFuture;
  return [
    for (final classInfo in classes)
      ClassRegisterSummary(
        classInfo: classInfo,
        session: sessions[classInfo.id],
      ),
  ];
});

// ---------------------------------------------------------------------------
// One register
// ---------------------------------------------------------------------------

/// A class's student display names, best-effort: an empty map (rows fall back to a short id) when
/// the roster can't be read — see [AttendanceOfficeClient.listStudentNames].
final officeStudentNamesProvider =
    FutureProvider.family<Map<String, String>, String>((ref, classId) async {
      ref.watch(authStatusProvider);
      try {
        return await ref
            .watch(attendanceOfficeClientProvider)
            .listStudentNames(classId);
      } catch (_) {
        return const {};
      }
    });

final officeRosterProvider = FutureProvider.family<List<String>, String>((
  ref,
  classId,
) {
  return ref.watch(attendanceOfficeClientProvider).listRoster(classId);
});

final officeSessionRecordsProvider =
    FutureProvider.family<List<AttendanceRecord>, String>((ref, sessionId) {
      return ref
          .watch(attendanceOfficeClientProvider)
          .listSessionRecords(sessionId);
    });

/// Identifies one office register: a class on a date.
typedef OfficeRegisterScope = ({String classId, DateTime date});

/// The roster (sorted by name), the day's session and its records for one class.
final officeRegisterProvider =
    FutureProvider.family<OfficeRegister, OfficeRegisterScope>((
      ref,
      scope,
    ) async {
      final rosterFuture = ref.watch(
        officeRosterProvider(scope.classId).future,
      );
      final sessionsFuture = ref.watch(
        dailySessionsProvider(scope.date).future,
      );
      final namesFuture = ref.watch(
        officeStudentNamesProvider(scope.classId).future,
      );
      final roster = await rosterFuture;
      final session = (await sessionsFuture)[scope.classId];
      final names = await namesFuture;

      final records = session == null
          ? const <AttendanceRecord>[]
          : await ref.watch(officeSessionRecordsProvider(session.id).future);

      String sortKey(String id) => (names[id] ?? id).toLowerCase();
      return OfficeRegister(
        rosterStudentIds: [...roster]
          ..sort((a, b) => sortKey(a).compareTo(sortKey(b))),
        session: session,
        records: records,
      );
    });
