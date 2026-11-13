import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/auth_interceptor.dart';
import '../api/error_mapping_interceptor.dart';
import '../di/app_providers.dart';
import 'auth_providers.dart';

/// A bare [Dio] for a hand-written feature client, configured exactly as `apiClientProvider`
/// configures the generated client's: the API base URL, bearer injection with 401 recovery and
/// the closed-school sign-out, and [ErrorMappingInterceptor] last so every non-2xx carries a typed
/// `ApiException`.
///
/// For surfaces the generated client can't serve (see `features/teacher/data/mark_sheet_client.dart`
/// and `features/student/data/academic_results_client.dart`). Call it from a provider body so the
/// client is rebuilt when the network config or session changes.
Dio authenticatedDio(Ref ref) {
  final baseUrl = ref.watch(networkConfigProvider).apiBaseUrl;
  final session = ref.watch(authSessionProvider);
  final dio = Dio(BaseOptions(baseUrl: baseUrl.toString()));
  dio.interceptors
    ..add(
      AuthInterceptor(
        () => session.tokenProvider,
        onUnauthorized: () =>
            ref.read(authNotifierProvider.notifier).handleAuthFailure(),
        onSchoolClosed: () =>
            ref.read(authNotifierProvider.notifier).handleSchoolClosed(),
        retryClient: dio,
      ),
    )
    ..add(ErrorMappingInterceptor());
  return dio;
}
