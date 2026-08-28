import '../api/generated/academics/academics_client.dart';
import '../api/generated/models/exam.dart';
import 'cached_value.dart';
import 'offline_cached_resource.dart';
import 'offline_database.dart';

/// Offline-cached exams for a fixed set of classes — the student timetable screen's exam overlay.
///
/// `GET /api/academics/exams` is scoped to one `class_id` per call, so this fans out one request
/// per class and merges the results into a single cached list. The cache key is the sorted class
/// ids joined, so a student whose enrolment set doesn't change reuses one entry across weeks
/// (exams are filtered to a given week in the domain layer, not here).
class ExamsOfflineRepository {
  ExamsOfflineRepository({required OfflineDatabase database, required AcademicsClient client})
    : _client = client,
      _cache = OfflineCachedResource<List<Exam>>(
        database: database,
        resource: 'exams',
        encode: (exams) => exams.map((exam) => exam.toJson()).toList(),
        decode: (json) => (json as List<Object?>)
            .map((exam) => Exam.fromJson(exam as Map<String, Object?>))
            .toList(),
      );

  final AcademicsClient _client;
  final OfflineCachedResource<List<Exam>> _cache;

  /// Exams for every class in [classIds], served from cache first and reconciled against the
  /// server. Order within the returned list is unspecified; callers sort for display.
  Stream<CachedValue<List<Exam>>> examsForClasses(List<String> classIds) {
    final key = (classIds.toList()..sort()).join(',');
    return _cache.sync(key, () async {
      final pages = await Future.wait(
        classIds.map((classId) => _client.listExams(classId: classId, limit: 200)),
      );
      final byId = <String, Exam>{};
      for (final page in pages) {
        for (final exam in page.exams) {
          byId[exam.id] = exam;
        }
      }
      return byId.values.toList();
    });
  }
}
