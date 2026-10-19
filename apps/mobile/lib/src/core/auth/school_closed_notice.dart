import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

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

/// Whether the login screen should say "This app is no longer available for your school."
///
/// Set when the session is ended because the school was closed (by its admin from the Profile
/// tab, or discovered on any API call, refresh or sign-in attempt), and cleared by the next
/// successful sign-in. Kept in a provider rather than a snackbar so the message stays on the
/// login screen for as long as it is true.
class SchoolClosedNoticeNotifier extends Notifier<bool> {
  @override
  bool build() => false;

  void show() => state = true;

  void clear() => state = false;
}

final schoolClosedNoticeProvider =
    NotifierProvider<SchoolClosedNoticeNotifier, bool>(
      SchoolClosedNoticeNotifier.new,
    );
