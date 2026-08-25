import 'package:dio/dio.dart';

import 'auth_interceptor.dart';
import 'error_mapping_interceptor.dart';
import 'generated/studafy_api_client.dart';

export 'api_exception.dart';
export 'auth_interceptor.dart' show TokenProvider;
export 'generated/studafy_api_client.dart' show StudafyApiClient;

/// Builds a typed Dio client for the Studafy API from the generated [StudafyApiClient] — see
/// `generated/studafy_api_client.dart` (regenerate via `bun run --cwd apps/mobile client:generate`;
/// never hand-edit it). Every domain client hangs off the returned instance, e.g. `api.health`,
/// `api.students`; each method is typed end-to-end against the OpenAPI contract.
///
/// Interceptors run in request order — auth, then the error mapper last, so it owns the response
/// phase and attaches a typed [ApiException] to any non-2xx [DioException].
StudafyApiClient createApiClient({required Uri baseUrl, TokenProvider? getToken, Dio? dio}) {
  final client = dio ?? Dio(BaseOptions(baseUrl: baseUrl.toString()));

  if (getToken != null) {
    client.interceptors.add(AuthInterceptor(getToken));
  }
  client.interceptors.add(ErrorMappingInterceptor());

  return StudafyApiClient(client);
}
