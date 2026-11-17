import 'dart:io';

import 'package:dio/dio.dart';

import '../domain/ai_source.dart';

/// A file ready to upload as an AI source: where it is on the device, its name, exact size and
/// content type.
typedef AiSourceFile = ({String path, String name, int sizeBytes, String contentType});

/// Client for the student's own AI sources (`/api/ai/students/{studentId}/sources` and
/// `.../assignment-sources`).
///
/// Hand-written like `AiStudyClient`: the `AI` tag is excluded from the generated client. Plain
/// buffered JSON, so the shared `ErrorMappingInterceptor` turns a problem+json refusal into an
/// `ApiException` on the thrown [DioException].
///
/// Concrete rather than an interface; tests substitute it by `implements AiSourcesClient` through
/// `aiSourcesClientProvider`.
class AiSourcesClient {
  AiSourcesClient(this._dio, {Dio? uploadDio}) : _uploadDio = uploadDio ?? Dio();

  final Dio _dio;

  /// For the pre-signed PUT to storage: no API base URL, no bearer token.
  final Dio _uploadDio;

  String _sources(String studentId) => '/api/ai/students/$studentId/sources';

  /// The student's own files and photos, newest first, with their allowance.
  Future<AiPersonalSources> list({required String studentId}) async {
    final response = await _dio.get<Map<String, dynamic>>(_sources(studentId));
    return AiPersonalSources.fromJson(response.data ?? const {});
  }

  /// One source of either kind, for following it through the pipeline.
  Future<AiPreparedSource> get({required String studentId, required String sourceId}) async {
    final response = await _dio.get<Map<String, dynamic>>('${_sources(studentId)}/$sourceId');
    return AiPreparedSource.fromJson(response.data ?? const {});
  }

  /// Uploads [file] and sends it to the malware scan: start the upload, PUT the bytes to the
  /// signed URL, confirm. [onProgress] gets 0..1 while the bytes go up.
  Future<void> upload({
    required String studentId,
    required AiSourceFile file,
    void Function(double progress)? onProgress,
  }) async {
    final started = await _dio.post<Map<String, dynamic>>(
      '${_sources(studentId)}/upload',
      data: {
        'original_file_name': file.name,
        'mime_type': file.contentType,
        'size_bytes': file.sizeBytes,
      },
    );
    final body = started.data ?? const {};
    final source = body['source'];
    final sourceId = source is Map<String, dynamic> ? source['id'] as String? : null;
    final uploadUrl = body['upload_url'] as String?;
    final storageKey = body['storage_key'] as String?;
    if (sourceId == null || uploadUrl == null || storageKey == null) {
      throw StateError('The upload could not be started.');
    }

    await _uploadDio.put<void>(
      uploadUrl,
      data: File(file.path).openRead(),
      options: Options(
        contentType: file.contentType,
        headers: {Headers.contentLengthHeader: file.sizeBytes},
      ),
      onSendProgress: onProgress == null
          ? null
          : (sent, total) => onProgress(total > 0 ? sent / total : 0),
    );

    await _dio.post<Map<String, dynamic>>(
      '${_sources(studentId)}/$sourceId/confirm',
      data: {'storage_key': storageKey},
    );
  }

  /// Deletes one of the student's own files or photos, and its text.
  Future<void> delete({required String studentId, required String sourceId}) async {
    await _dio.delete<void>('${_sources(studentId)}/$sourceId');
  }

  /// The student's assignments that can be used as a source.
  Future<List<AiAssignmentSource>> assignments({required String studentId}) async {
    final response = await _dio.get<Map<String, dynamic>>(
      '/api/ai/students/$studentId/assignment-sources',
    );
    final raw = response.data?['assignments'];
    if (raw is! List) return const [];
    return [
      for (final item in raw)
        if (item is Map<String, dynamic>) AiAssignmentSource.fromJson(item),
    ];
  }

  /// Uses [assignmentId] as a source: builds it the first time (or after the assignment changed)
  /// and returns it, ready or on its way.
  Future<AiPreparedSource> prepareAssignment({
    required String studentId,
    required String assignmentId,
  }) async {
    final response = await _dio.post<Map<String, dynamic>>(
      '/api/ai/students/$studentId/assignment-sources/$assignmentId',
    );
    return AiPreparedSource.fromJson(response.data ?? const {});
  }
}
