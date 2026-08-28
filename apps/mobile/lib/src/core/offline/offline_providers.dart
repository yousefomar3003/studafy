import 'package:drift/drift.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../auth/auth_providers.dart';
import '../auth/auth_state.dart';
import 'announcements_offline_repository.dart';
import 'assignments_offline_repository.dart';
import 'materials_offline_repository.dart';
import 'offline_database.dart';
import 'published_grades_offline_repository.dart';
import 'timetable_offline_repository.dart';

/// The storage backend for [offlineDatabaseProvider]. Null (the default) opens the real on-disk
/// database lazily; tests override this with an in-memory [QueryExecutor] so the auth-driven
/// clear-on-logout wiring below is exercisable without touching disk or `path_provider`.
final offlineDatabaseExecutorProvider = Provider<QueryExecutor?>((ref) => null);

/// The app-wide offline cache database. A plain (non-autoDispose) provider — same lifetime as
/// `apiClientProvider` — so every repository below shares one connection.
///
/// Wipes itself the moment a session logs out (`AuthStatus.authenticated` -> `unauthenticated`):
/// cached school data must not survive into a different account signing in on the same device.
/// This mirrors `app_providers.dart`'s `routerProvider`, which wires its own `ref.listen` on
/// `authStatusProvider` the same way rather than needing a separate provider to be read at boot.
final offlineDatabaseProvider = Provider<OfflineDatabase>((ref) {
  final database = OfflineDatabase(ref.watch(offlineDatabaseExecutorProvider));
  ref.onDispose(database.close);

  ref.listen(authStatusProvider, (previous, next) {
    if (previous == AuthStatus.authenticated && next == AuthStatus.unauthenticated) {
      database.clearAll();
    }
  });

  return database;
});

final timetableOfflineRepositoryProvider = Provider<TimetableOfflineRepository>((ref) {
  return TimetableOfflineRepository(
    database: ref.watch(offlineDatabaseProvider),
    client: ref.watch(apiClientProvider).timetable,
  );
});

final publishedGradesOfflineRepositoryProvider = Provider<PublishedGradesOfflineRepository>((ref) {
  return PublishedGradesOfflineRepository(
    database: ref.watch(offlineDatabaseProvider),
    client: ref.watch(apiClientProvider).publishedGrades,
  );
});

final materialsOfflineRepositoryProvider = Provider<MaterialsOfflineRepository>((ref) {
  return MaterialsOfflineRepository(
    database: ref.watch(offlineDatabaseProvider),
    client: ref.watch(apiClientProvider).academics,
  );
});

final announcementsOfflineRepositoryProvider = Provider<AnnouncementsOfflineRepository>((ref) {
  return AnnouncementsOfflineRepository(
    database: ref.watch(offlineDatabaseProvider),
    client: ref.watch(apiClientProvider).announcements,
  );
});

final assignmentsOfflineRepositoryProvider = Provider<AssignmentsOfflineRepository>((ref) {
  return AssignmentsOfflineRepository(
    database: ref.watch(offlineDatabaseProvider),
    client: ref.watch(apiClientProvider).assignments,
  );
});
