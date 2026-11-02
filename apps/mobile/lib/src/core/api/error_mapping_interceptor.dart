import 'package:dio/dio.dart';

import 'api_exception.dart';

/// Dio interceptor that attaches a typed [ApiException] to any non-2xx response.
///
/// Dio can only reject an error chain with a [DioException] — not an arbitrary object — so this
/// rebuilds the exception with [ApiException.fromResponse] set as [DioException.error] rather than
/// throwing [ApiException] directly. Read it back with [DioExceptionApiError.apiError]. A request
/// that never reached the server (timeout, no connection — `response` is `null`) is left alone: it
/// carries no problem+json body to map, and propagates as a plain [DioException].
class ErrorMappingInterceptor extends Interceptor {
  @override
  void onError(DioException err, ErrorInterceptorHandler handler) {
    final response = err.response;
    if (response == null) {
      handler.next(err);
      return;
    }

    handler.next(
      DioException(
        requestOptions: err.requestOptions,
        response: response,
        type: err.type,
        error: ApiException.fromResponse(response),
        stackTrace: err.stackTrace,
        message: err.message,
      ),
    );
  }
}
