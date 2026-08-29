import 'dart:io';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/generated/models/material.dart';
import '../../../core/api/storage_download_client.dart';
import '../../../core/auth/auth_providers.dart';
import '../../../core/offline/cached_value.dart';
import '../../../core/offline/material_file_cache.dart';
import '../../../core/offline/offline_providers.dart';

/// Offline-cached materials for one class — see `MaterialsOfflineRepository`.
final materialsForClassProvider = StreamProvider.autoDispose
    .family<CachedValue<List<Material>>, String>((ref, classId) {
      return ref.watch(materialsOfflineRepositoryProvider).materialsForClass(classId);
    });

/// A class's display code by id ("MATH101-A" rather than a UUID). Mirrors
/// `timetable_day_section.dart`'s private `_classCodeProvider` — public here since more than one
/// materials widget resolves it (the class-section header today; the viewer screen could add a
/// breadcrumb later without a second lookup).
final materialsClassCodeProvider = FutureProvider.autoDispose.family<String, String>((
  ref,
  classId,
) async {
  final classValue = await ref.watch(apiClientProvider).academics.getClass(classId: classId);
  return classValue.code;
});

/// A freshly-minted pre-signed download URL for [materialId].
///
/// A plain family provider, not cached beyond Riverpod's own lifetime, on purpose: the gateway's
/// URL is only valid for `DOWNLOAD_PRESIGN_TTL_SECONDS` (5 minutes server-side —
/// `apps/api/src/modules/storage/download-service.ts`), so "refreshing an expired one" is just
/// minting a new one. Callers that need a URL guaranteed fresh at the moment of use call
/// `ref.refresh(materialDownloadUrlProvider(materialId).future)` right before using it, rather
/// than trusting a value fetched earlier in the same screen's life.
final materialDownloadUrlProvider = FutureProvider.autoDispose.family<StorageDownloadUrl, String>((
  ref,
  materialId,
) {
  return ref
      .watch(storageDownloadClientProvider)
      .download(contentClass: StorageDownloadClass.material, objectId: materialId);
});

/// Whether [materialId]'s file is already cached on-device for offline viewing. A passive check —
/// unlike [ensureMaterialDownloadedProvider], it never triggers a download — so every row on the
/// materials list can watch it without kicking off network activity just by being on screen.
final materialDownloadedProvider = FutureProvider.autoDispose.family<bool, String>((
  ref,
  materialId,
) async {
  final file = await ref.watch(materialFileCacheProvider).find(materialId);
  return file != null;
});

/// Ensures [materialId]'s file is downloaded and cached on-device, downloading it first if
/// necessary, and returns the local [File] either way. This is what the in-app PDF/image preview
/// watches to get something to render — the download *is* how a file becomes previewable and
/// available offline, not a separate step before it.
///
/// Retried exactly once against a freshly re-minted URL on any failure — the concrete shape of
/// "an expired URL auto-refreshes": a download that fails because the 5-minute-lived URL expired
/// between minting and use (slow device, a stalled connection, a retry after a transient network
/// blip) gets a second attempt with a brand new one rather than surfacing a dead link.
final ensureMaterialDownloadedProvider = FutureProvider.autoDispose.family<File, String>((
  ref,
  materialId,
) async {
  final cache = ref.watch(materialFileCacheProvider);
  final cached = await cache.find(materialId);
  if (cached != null) return cached;

  Future<File> attempt() async {
    final url = await ref.refresh(materialDownloadUrlProvider(materialId).future);
    final dio = ref.read(materialBytesDioProvider);
    final response = await dio.get<List<int>>(
      url.downloadUrl,
      options: Options(responseType: ResponseType.bytes),
    );
    final saved = await cache.save(
      materialId,
      url.originalFileName,
      Uint8List.fromList(response.data!),
    );
    ref.invalidate(materialDownloadedProvider(materialId));
    return saved;
  }

  try {
    return await attempt();
  } on DioException {
    return attempt();
  }
});
