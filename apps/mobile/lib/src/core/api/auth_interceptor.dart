import 'package:dio/dio.dart';

/// Supplies the bearer token for the active session, or `null` when the caller is unauthenticated.
/// Async so the token can come from a refreshing store. Nothing in this repo issues a token yet
/// (see the OpenAPI `bearerAuth` scheme, declared but required by no operation); this interceptor
/// is the seam that activates the moment one does.
typedef TokenProvider = Future<String?> Function();

/// Dio interceptor that attaches `Authorization: Bearer <token>` to every outbound request when a
/// token is available, and leaves the request untouched otherwise (public routes stay anonymous).
class AuthInterceptor extends Interceptor {
  AuthInterceptor(this._getToken);

  final TokenProvider _getToken;

  @override
  Future<void> onRequest(RequestOptions options, RequestInterceptorHandler handler) async {
    final token = await _getToken();
    if (token != null) {
      options.headers['Authorization'] = 'Bearer $token';
    }
    handler.next(options);
  }
}
