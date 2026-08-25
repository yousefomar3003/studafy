import 'package:dio/dio.dart';

/// Thrown for any non-2xx response from the Studafy API. Catch it via [DioExceptionApiError] —
/// see [ErrorMappingInterceptor] for how it gets attached to the [DioException] Dio still throws.
///
/// Every Studafy API error is an RFC 9457 `application/problem+json` document carrying the
/// standard members plus two extensions: `code`, a stable machine-readable error code, and
/// `request_id`, the server-generated correlation id (also echoed in the `X-Request-Id` response
/// header). Read [code], never [title] or [detail] — those are prose and may be localized.
///
/// Not generated: retrofit-style clients only type the success (2xx) response, so `ProblemDetails`
/// — used exclusively in this API's 4xx/5xx response bodies — never appears as a model in
/// `generated/`. This class parses the same RFC 9457 shape by hand instead.
class ApiException implements Exception {
  const ApiException({
    required this.status,
    required this.title,
    this.code,
    this.detail,
    this.instance,
    this.type,
    this.requestId,
    this.problem,
  });

  /// Builds an [ApiException] from a Dio [Response] whose status was not 2xx. A body that is not a
  /// parseable problem (a proxy error page, an empty body) degrades to a generic exception built
  /// from the status code and headers, rather than inventing fields.
  factory ApiException.fromResponse(Response<dynamic> response) {
    final headerRequestId = response.headers.value('x-request-id');
    final body = response.data;
    final problem = body is Map ? Map<String, Object?>.from(body) : null;

    String? asString(Object? value) => value is String ? value : null;

    return ApiException(
      status: _asIntOrNull(problem?['status']) ?? response.statusCode ?? -1,
      title: asString(problem?['title']) ?? response.statusMessage ?? 'Request failed',
      code: asString(problem?['code']),
      detail: asString(problem?['detail']),
      instance: asString(problem?['instance']),
      type: asString(problem?['type']),
      requestId: asString(problem?['request_id']) ?? headerRequestId,
      problem: problem,
    );
  }

  /// HTTP status code of the failing response.
  final int status;

  /// Short, human-readable summary. Prose — may be localized; branch on [code] instead.
  final String title;

  /// Stable machine-readable error code, or `null` when the body was not a parseable problem.
  final String? code;

  /// Human-readable explanation. Absent on 5xx by design; `null` when not provided.
  final String? detail;

  /// URI reference identifying the specific occurrence (e.g. the request path).
  final String? instance;

  /// Problem type URI (`about:blank` when unclassified); `null` when the body did not parse.
  final String? type;

  /// Correlation id: the body's `request_id`, else the `X-Request-Id` response header, else `null`.
  /// Quote this to support — it correlates with server logs and the audit trail.
  final String? requestId;

  /// The raw parsed problem body, or `null` when the response carried no parseable problem.
  final Map<String, Object?>? problem;

  @override
  String toString() {
    final base = code != null ? '$code: $title' : title;
    return requestId != null ? '$base (request_id: $requestId)' : base;
  }
}

/// Extracts an `int` from a JSON-decoded value without throwing — `status` is a JSON number, which
/// `dart:convert` already decodes as `int`, but this stays defensive against a body that doesn't
/// match the contract.
int? _asIntOrNull(Object? value) => value is int ? value : null;

/// Ergonomic access to the [ApiException] an [ErrorMappingInterceptor] attaches to a
/// [DioException], mirroring the TypeScript client's `catch (e) { if (e instanceof ApiError) }`:
///
/// ```dart
/// try {
///   await api.health.getLiveness();
/// } on DioException catch (e) {
///   final apiError = e.apiError;
///   if (apiError != null) {
///     // detail / instance / code / status / requestId are all typed and available here.
///   }
/// }
/// ```
extension DioExceptionApiError on DioException {
  ApiException? get apiError => error is ApiException ? error as ApiException : null;
}
