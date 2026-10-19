import 'package:dio/dio.dart';

import '../auth/school_closed_notice.dart';

/// Supplies the bearer token for the active session, or `null` when the caller is unauthenticated.
/// Async so the token can come from a refreshing store (see `AuthSession.tokenProvider`).
typedef TokenProvider = Future<String?> Function();

/// Dio interceptor that attaches `Authorization: Bearer <token>` to every outbound request when a
/// token is available, and leaves the request untouched otherwise (public routes stay anonymous).
///
/// When [onUnauthorized] and [retryClient] are given, a 401 triggers one silent recovery:
/// [onUnauthorized] renews the session (returning whether it succeeded), and the original request
/// is replayed once through [retryClient] with the new token. A second 401, or a failed renewal,
/// is passed on unchanged — [onUnauthorized] is where the app signs the user out.
///
/// When [onSchoolClosed] is given, an authenticated request the API refuses with
/// `SCHOOL_SUSPENDED` (the school was closed) calls it — no renewal is attempted, since none can
/// succeed — and the error is then passed on unchanged.
class AuthInterceptor extends Interceptor {
  AuthInterceptor(this._getToken, {this.onUnauthorized, this.onSchoolClosed, this.retryClient});

  final TokenProvider _getToken;

  /// Renews the session after a 401. `true` means retry the request.
  final Future<bool> Function()? onUnauthorized;

  /// Ends the session after the API reports the school closed.
  final Future<void> Function()? onSchoolClosed;

  /// The client the original request is replayed through after a successful renewal.
  final Dio? retryClient;

  static const _retriedKey = 'authRetried';

  @override
  Future<void> onRequest(RequestOptions options, RequestInterceptorHandler handler) async {
    final token = await _getToken();
    if (token != null) {
      options.headers['Authorization'] = 'Bearer $token';
    }
    handler.next(options);
  }

  @override
  Future<void> onError(DioException err, ErrorInterceptorHandler handler) async {
    final options = err.requestOptions;

    // Only for a request that carried a session: an anonymous call (an invitation lookup, say)
    // answering SCHOOL_SUSPENDED is about that request, not about a signed-in user's school.
    final schoolClosed = onSchoolClosed;
    if (schoolClosed != null &&
        options.headers.containsKey('Authorization') &&
        isSchoolClosedResponse(err.response)) {
      await schoolClosed();
      handler.next(err);
      return;
    }

    final recover = onUnauthorized;
    final client = retryClient;
    if (err.response?.statusCode != 401 ||
        recover == null ||
        client == null ||
        options.extra[_retriedKey] == true) {
      handler.next(err);
      return;
    }

    if (!await recover()) {
      handler.next(err);
      return;
    }

    options.extra[_retriedKey] = true;
    try {
      handler.resolve(await client.fetch<dynamic>(options));
    } on DioException catch (retryError) {
      handler.next(retryError);
    }
  }
}
