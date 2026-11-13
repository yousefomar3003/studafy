import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../auth/auth_providers.dart';
import '../di/app_providers.dart';
import 'auth_interceptor.dart';
import 'error_mapping_interceptor.dart';

/// One of the storage gateway's download classes
/// (`GET /api/storage/downloads/{contentClass}/{objectId}`, `DOWNLOAD_CLASS_KEYS` in
/// `apps/api/src/modules/storage/content-classes.ts`). Only the classes a mobile client actually
/// resolves an object for are modeled — `material` today.
enum StorageDownloadClass {
  material;

  String get wireValue => switch (this) {
    StorageDownloadClass.material => 'material',
  };
}

/// A freshly-minted pre-signed download URL from the storage gateway.
class StorageDownloadUrl {
  const StorageDownloadUrl({
    required this.downloadUrl,
    required this.expiresAt,
    required this.originalFileName,
  });

  factory StorageDownloadUrl.fromJson(Map<String, Object?> json) => StorageDownloadUrl(
    downloadUrl: json['download_url']! as String,
    expiresAt: DateTime.parse(json['expires_at']! as String),
    originalFileName: json['original_file_name']! as String,
  );

  /// Short-lived (`DOWNLOAD_PRESIGN_TTL_SECONDS` — 5 minutes server-side) pre-signed GET URL.
  final String downloadUrl;
  final DateTime expiresAt;
  final String originalFileName;
}

/// Hand-written client for the storage download gateway — not generated, unlike every other
/// domain client under `generated/`.
///
/// The gateway's `contentClass` path segment (`downloadParamsSchema.contentClass`,
/// `apps/api/src/modules/storage/schemas.ts`) is an inline, unnamed enum in the OpenAPI document:
/// it has no `components/schemas` entry, only a literal `enum: [...]` on the parameter itself. A
/// schema without a registered name gets its Dart type minted by `swagger_parser` from
/// generation order across the *whole* spec — the same mechanism that produced the already
/// generated `Status11`/`Status12` for the (equally anonymous) timetable-version and assignment
/// status query parameters. That name shifts on any unrelated spec change elsewhere, so it isn't
/// safe for hand-written code to reference; this client calls the path directly instead and
/// hand-parses the response body, whose shape *is* named and stable (`downloadUrlResponseSchema`).
///
/// Shares the [ErrorMappingInterceptor] contract with the generated client: a non-2xx response
/// throws a [DioException] with a typed `ApiException` attached (`api_exception.dart`), so a
/// caller reads it back the same way as any other typed call — `e.apiError`.
class StorageDownloadClient {
  StorageDownloadClient(this._dio);

  final Dio _dio;

  /// Mints a short-lived pre-signed GET URL for [objectId] under [contentClass]. Throws a
  /// [DioException] (404, via `ApiException`) when the object doesn't exist, isn't visible to the
  /// caller, or — for [StorageDownloadClass.material] specifically — hasn't reached the `ready`
  /// ingest state yet: the gateway's row-scope query filters on it server-side (`RESOLVERS.material`
  /// in `apps/api/src/modules/storage/download-service.ts`), so a still-scanning or quarantined
  /// material never resolves to a URL no matter how the caller asks.
  Future<StorageDownloadUrl> download({
    required StorageDownloadClass contentClass,
    required String objectId,
  }) async {
    final response = await _dio.get<Map<String, Object?>>(
      '/api/storage/downloads/${contentClass.wireValue}/$objectId',
    );
    return StorageDownloadUrl.fromJson(response.data!);
  }
}

/// A [Dio] wired identically to the generated client's (`api_client.dart`'s `createApiClient`) —
/// same base URL, same auth token injection, same [ErrorMappingInterceptor] — but standing on its
/// own rather than reusing [apiClientProvider]'s instance, which does not expose the [Dio] it
/// builds internally.
final storageDownloadClientProvider = Provider<StorageDownloadClient>((ref) {
  final baseUrl = ref.watch(networkConfigProvider).apiBaseUrl;
  final session = ref.watch(authSessionProvider);
  final dio = Dio(BaseOptions(baseUrl: baseUrl.toString()))
    ..interceptors.add(AuthInterceptor(() => session.tokenProvider))
    ..interceptors.add(ErrorMappingInterceptor());
  return StorageDownloadClient(dio);
});
