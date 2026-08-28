import '../api/generated/assignments/assignments_client.dart';
import '../api/generated/models/assignment.dart';
import '../api/generated/models/status12.dart';
import 'cached_value.dart';
import 'offline_cached_resource.dart';
import 'offline_database.dart';

/// Offline-cached due-soon assignments for the calling student.
///
/// `listAssignments` is already scoped server-side to what the caller may see — a student gets
/// only published work for classes they are actively enrolled in — so unlike
/// [PublishedGradesOfflineRepository] this needs no student id of its own.
class AssignmentsOfflineRepository {
  AssignmentsOfflineRepository({
    required OfflineDatabase database,
    required AssignmentsClient client,
  }) : _client = client,
       _cache = OfflineCachedResource<List<Assignment>>(
         database: database,
         resource: 'assignments_due_soon',
         encode: (assignments) => assignments.map((assignment) => assignment.toJson()).toList(),
         decode: (json) => (json as List<Object?>)
             .map((assignment) => Assignment.fromJson(assignment as Map<String, Object?>))
             .toList(),
       );

  final AssignmentsClient _client;
  final OfflineCachedResource<List<Assignment>> _cache;

  static const _dueSoonCacheKey = 'due_soon';

  /// The caller's own upcoming assignments, nearest deadline first, served from cache first and
  /// reconciled against the server.
  Stream<CachedValue<List<Assignment>>> dueSoon({int limit = 5}) {
    return _cache.sync(_dueSoonCacheKey, () async {
      final page = await _client.listAssignments(status: Status12.upcoming, limit: limit);
      // Sorted client-side rather than trusted from the API: `listAssignments` documents no
      // ordering guarantee, and "nearest deadline first" is specific to this due-soon view, not
      // a property of the endpoint itself.
      final assignments = [...page.assignments]..sort((a, b) => a.dueAt.compareTo(b.dueAt));
      return assignments;
    });
  }
}
