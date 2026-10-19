/// The closed-school error helpers, kept free of Flutter so the API client (and its pure-Dart
/// integration tests) can use them.
library;

import 'package:dio/dio.dart';

import '../api/api_exception.dart';

/// The API's error code for "your school is not available": a closed (archived) school on any
/// request, refresh or sign-in, and a suspended school at sign-in. See
/// `apps/api/src/modules/auth/school-access.ts`.
const schoolClosedErrorCode = 'SCHOOL_SUSPENDED';

/// Whether [error] is the API refusing the session because the school is closed.
bool isSchoolClosedError(Object? error) =>
    error is DioException && error.apiError?.code == schoolClosedErrorCode;

/// Whether a raw [response] carries the closed-school problem code — for interceptors that run
/// before [ApiException] mapping has happened.
bool isSchoolClosedResponse(Response<dynamic>? response) {
  final body = response?.data;
  return body is Map && body['code'] == schoolClosedErrorCode;
}
