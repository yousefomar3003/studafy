import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/auth_interceptor.dart';
import '../../../core/api/error_mapping_interceptor.dart';
import '../../../core/auth/auth_providers.dart';
import '../../../core/di/app_providers.dart';
import '../../../core/offline/offline_providers.dart';
import '../data/exam_client.dart';
import '../data/exam_progress_store.dart';

/// [ExamClient] on its own [Dio], wired identically to `quizClientProvider` — same base URL,
/// same bearer-token injection, same [ErrorMappingInterceptor] — but standing alone for the same
/// reason: `ExamClient` hand-parses its endpoints rather than going through the generated client
/// (see its doc comment).
final examClientProvider = Provider<ExamClient>((ref) {
  final baseUrl = ref.watch(networkConfigProvider).apiBaseUrl;
  final session = ref.watch(authSessionProvider);
  final dio = Dio(BaseOptions(baseUrl: baseUrl.toString()))
    ..interceptors.add(AuthInterceptor(() => session.tokenProvider))
    ..interceptors.add(ErrorMappingInterceptor());
  return ExamClient(dio);
});

final examProgressStoreProvider = Provider<ExamProgressStore>((ref) {
  return ExamProgressStore(ref.watch(offlineDatabaseProvider));
});
