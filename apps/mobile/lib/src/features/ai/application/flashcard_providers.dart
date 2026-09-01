import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/auth_interceptor.dart';
import '../../../core/api/error_mapping_interceptor.dart';
import '../../../core/auth/auth_providers.dart';
import '../../../core/di/app_providers.dart';
import '../../../core/offline/offline_providers.dart';
import '../data/flashcard_client.dart';
import '../data/flashcard_library_store.dart';

/// Mirrors `AI_FLASHCARD_MIN_CARDS` / `AI_FLASHCARD_MAX_CARDS` / `AI_FLASHCARD_DEFAULT_CARDS`
/// (`apps/api/src/modules/ai/config.ts`) so the generate step can't ask for a count the server
/// would reject. Material selection reuses `AI_QUIZ_MAX_MATERIALS` server-side (deck generation
/// rides the quiz generator's loader — `docs/rag/flashcards-and-spaced-repetition.md`), so the cap
/// here matches `quizMaxMaterials`.
const int flashcardMinCards = 1;
const int flashcardMaxCards = 20;
const int flashcardDefaultCards = 10;
const int flashcardMaxMaterials = 5;

/// [FlashcardClient] on its own [Dio], wired identically to `quizClientProvider` — same base URL,
/// same bearer-token injection, same [ErrorMappingInterceptor] — standing alone for the same
/// reason: the `AI` tag is excluded from codegen (see `pubspec.yaml`).
final flashcardClientProvider = Provider<FlashcardClient>((ref) {
  final baseUrl = ref.watch(networkConfigProvider).apiBaseUrl;
  final session = ref.watch(authSessionProvider);
  final dio = Dio(BaseOptions(baseUrl: baseUrl.toString()))
    ..interceptors.add(AuthInterceptor(() => session.tokenProvider))
    ..interceptors.add(ErrorMappingInterceptor());
  return FlashcardClient(dio);
});

final flashcardLibraryStoreProvider = Provider<FlashcardLibraryStore>((ref) {
  return FlashcardLibraryStore(ref.watch(offlineDatabaseProvider));
});
