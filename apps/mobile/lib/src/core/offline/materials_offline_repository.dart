import '../api/generated/academics/academics_client.dart';
import '../api/generated/models/material.dart';
import 'cached_value.dart';
import 'offline_cached_resource.dart';
import 'offline_database.dart';

/// Offline-cached class materials lists, one class at a time.
class MaterialsOfflineRepository {
  MaterialsOfflineRepository({required OfflineDatabase database, required AcademicsClient client})
    : _client = client,
      _cache = OfflineCachedResource<List<Material>>(
        database: database,
        resource: 'materials',
        encode: (materials) => materials.map((material) => material.toJson()).toList(),
        decode: (json) => (json as List<Object?>)
            .map((material) => Material.fromJson(material as Map<String, Object?>))
            .toList(),
      );

  final AcademicsClient _client;
  final OfflineCachedResource<List<Material>> _cache;

  /// Materials for [classId], served from cache first and reconciled against the server.
  Stream<CachedValue<List<Material>>> materialsForClass(String classId) {
    return _cache.sync(classId, () async {
      final page = await _client.listMaterials(classId: classId, limit: 200);
      return page.materials;
    });
  }
}
