import 'package:dio/dio.dart';

import 'release_config.dart';

/// The one read of `GET /api/mobile/config` — the release floor the app checks itself against on
/// launch and resume.
///
/// A hand-written Dio call rather than the generated client: this endpoint is unauthenticated and
/// must resolve before a session exists, so it hangs off a bare [Dio] (see
/// `updateConfigClientProvider`), not the session-bound `apiClientProvider`.
class UpdateConfigClient {
  UpdateConfigClient(this._dio);

  final Dio _dio;

  Future<ReleaseConfig> fetch() async {
    final response = await _dio.get<Map<String, dynamic>>('/api/mobile/config');
    return ReleaseConfig.fromJson(response.data ?? const {});
  }
}
