import '../api/generated/models/published_grade_snapshot.dart';
import '../api/generated/published_grades/published_grades_client.dart';
import 'cached_value.dart';
import 'offline_cached_resource.dart';
import 'offline_database.dart';

/// Offline-cached published grades, one student's one term at a time.
class PublishedGradesOfflineRepository {
  PublishedGradesOfflineRepository({
    required OfflineDatabase database,
    required PublishedGradesClient client,
  }) : _client = client,
       _cache = OfflineCachedResource<PublishedGradeSnapshot>(
         database: database,
         resource: 'published_grades',
         encode: (snapshot) => snapshot.toJson(),
         decode: (json) => PublishedGradeSnapshot.fromJson(json as Map<String, Object?>),
       );

  final PublishedGradesClient _client;
  final OfflineCachedResource<PublishedGradeSnapshot> _cache;

  /// [studentId]'s published grades for [termId], served from cache first and reconciled against
  /// the server.
  Stream<CachedValue<PublishedGradeSnapshot>> snapshotFor({
    required String studentId,
    required String termId,
  }) {
    return _cache.sync(
      '$studentId:$termId',
      () => _client.getPublishedGrades(studentId: studentId, termId: termId),
    );
  }
}
