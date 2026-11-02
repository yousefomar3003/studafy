import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/auth_interceptor.dart';
import '../../../core/api/error_mapping_interceptor.dart';
import '../../../core/auth/auth_providers.dart';
import '../../../core/di/app_providers.dart';
import '../../student/application/student_context_providers.dart';
import '../data/ai_photo_text_client.dart';
import '../data/ask_ai_client.dart';
import '../data/ask_ai_history_client.dart';

/// [AskAiClient] on its own [Dio], wired identically to `createApiClient` — same base URL, same
/// bearer-token injection, same [ErrorMappingInterceptor] — but standing alone because the
/// generated client's `Dio` isn't reachable and the streaming call needs per-request options
/// anyway. Same shape as `storageDownloadClientProvider`.
final askAiClientProvider = Provider<AskAiClient>((ref) {
  final baseUrl = ref.watch(networkConfigProvider).apiBaseUrl;
  final session = ref.watch(authSessionProvider);
  final dio = Dio(BaseOptions(baseUrl: baseUrl.toString()))
    ..interceptors.add(AuthInterceptor(() => session.tokenProvider))
    ..interceptors.add(ErrorMappingInterceptor());
  return AskAiClient(dio);
});

/// [AskAiHistoryClient] on the same kind of standalone [Dio] as [askAiClientProvider]: the `AI`
/// tag is excluded from the generated client.
final askAiHistoryClientProvider = Provider<AskAiHistoryClient>((ref) {
  final baseUrl = ref.watch(networkConfigProvider).apiBaseUrl;
  final session = ref.watch(authSessionProvider);
  final dio = Dio(BaseOptions(baseUrl: baseUrl.toString()))
    ..interceptors.add(AuthInterceptor(() => session.tokenProvider))
    ..interceptors.add(ErrorMappingInterceptor());
  return AskAiHistoryClient(dio);
});

/// [AiPhotoTextClient] on the same kind of standalone [Dio] as [askAiClientProvider]: the `AI`
/// tag is excluded from the generated client.
final aiPhotoTextClientProvider = Provider<AiPhotoTextClient>((ref) {
  final baseUrl = ref.watch(networkConfigProvider).apiBaseUrl;
  final session = ref.watch(authSessionProvider);
  final dio = Dio(BaseOptions(baseUrl: baseUrl.toString()))
    ..interceptors.add(AuthInterceptor(() => session.tokenProvider))
    ..interceptors.add(ErrorMappingInterceptor());
  return AiPhotoTextClient(dio);
});

/// The camera / library picker the Ask AI composer reads photos from; overridden in tests.
final aiPhotoPickerProvider = Provider<AiPhotoPicker>((ref) => AiPhotoPicker());

/// The `{studentId}` the AI routes take: the signed-in student's **student record id** (from
/// `GET /api/students/me`), not their user id. `app.ai_subscriptions`, conversations, quizzes and
/// reports are all keyed by the student record, and the server refuses any id that is not the
/// caller's own student record with 403.
///
/// Null while signed out, while `/students/me` is loading, or for a session with no student record;
/// the screens render their signed-out state then. Overridable in tests the same way as the other
/// student-context seams.
final askAiStudentIdProvider = Provider<String?>((ref) {
  return ref.watch(currentStudentIdProvider);
});
