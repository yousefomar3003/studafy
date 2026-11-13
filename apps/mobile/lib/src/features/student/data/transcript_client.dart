import 'package:dio/dio.dart';

import '../domain/transcript.dart';

/// Hand-written client for a student's academic transcripts (OpenAPI tag `Results`), shared by
/// the student's own results screen and a parent viewing a linked child. The API serves school
/// leadership, the student themself, or a linked parent; nobody else.
class TranscriptClient {
  TranscriptClient(this._dio);

  final Dio _dio;

  /// `GET /api/grading/students/{studentId}/transcripts` — newest first, superseded and revoked
  /// ones included.
  Future<List<AcademicTranscript>> fetchTranscripts(String studentId) async {
    final response = await _dio.get<Map<String, Object?>>(
      '/api/grading/students/$studentId/transcripts',
    );
    return [
      for (final row
          in (response.data?['transcripts'] as List<Object?>?) ??
              const <Object?>[])
        AcademicTranscript.fromJson(Map<String, Object?>.from(row! as Map)),
    ];
  }

  /// `GET /api/grading/transcripts/{transcriptId}` — one transcript exactly as issued.
  Future<AcademicTranscript> fetchTranscript(String transcriptId) async {
    final response = await _dio.get<Map<String, Object?>>(
      '/api/grading/transcripts/$transcriptId',
    );
    return AcademicTranscript.fromJson(response.data!);
  }
}
