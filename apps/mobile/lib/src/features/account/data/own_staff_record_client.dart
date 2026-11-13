import 'package:dio/dio.dart';

import '../domain/own_staff_record.dart';

/// Hand-written client for a member of staff's own record (OpenAPI tag "Staff and class records"),
/// for the reason given on `domain/own_staff_record.dart`. The API decides whose record it is from
/// the session -- there is no id to send -- and answers 403 for an account holding no staff role.
/// Wired on [authenticatedDio] by `ownStaffRecordClientProvider`.
class OwnStaffRecordClient {
  OwnStaffRecordClient(this._dio);

  final Dio _dio;

  /// `GET /api/me/staff-record` -- every field that is not sensitive, with its answer.
  Future<OwnStaffRecord> fetch() async {
    final response = await _dio.get<Map<String, Object?>>(
      '/api/me/staff-record',
    );
    return OwnStaffRecord.fromJson(response.data ?? const {});
  }

  /// `GET /api/me/staff-record/{fieldId}/document/download` -- a short-lived URL for a document
  /// field's file. Never cached: it expires within minutes.
  Future<Uri> documentUrl(String fieldId) async {
    final response = await _dio.get<Map<String, Object?>>(
      '/api/me/staff-record/$fieldId/document/download',
    );
    return Uri.parse(response.data!['url']! as String);
  }
}
