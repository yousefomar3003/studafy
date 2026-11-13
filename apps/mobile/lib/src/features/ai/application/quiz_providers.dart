import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/auth_interceptor.dart';
import '../../../core/api/error_mapping_interceptor.dart';
import '../../../core/auth/auth_providers.dart';
import '../../../core/di/app_providers.dart';
import '../../../core/offline/offline_providers.dart';
import '../data/quiz_client.dart';
import '../data/quiz_progress_store.dart';

/// [QuizClient] on its own [Dio], wired identically to `createApiClient` and to
/// `askAiClientProvider` — same base URL, same bearer-token injection, same
/// [ErrorMappingInterceptor] — but standing alone for the same reason: `QuizClient` hand-parses
/// its two endpoints rather than going through the generated client (see its doc comment).
final quizClientProvider = Provider<QuizClient>((ref) {
  final baseUrl = ref.watch(networkConfigProvider).apiBaseUrl;
  final session = ref.watch(authSessionProvider);
  final dio = Dio(BaseOptions(baseUrl: baseUrl.toString()))
    ..interceptors.add(AuthInterceptor(() => session.tokenProvider))
    ..interceptors.add(ErrorMappingInterceptor());
  return QuizClient(dio);
});

final quizProgressStoreProvider = Provider<QuizProgressStore>((ref) {
  return QuizProgressStore(ref.watch(offlineDatabaseProvider));
});
