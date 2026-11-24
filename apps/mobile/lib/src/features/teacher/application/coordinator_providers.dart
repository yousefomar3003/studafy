import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/authenticated_dio.dart';
import '../data/coordinator_client.dart';
import '../domain/coordinator.dart';

/// [CoordinatorClient] on its own [Dio] ([authenticatedDio]), like `markSheetClientProvider`.
final coordinatorClientProvider = Provider<CoordinatorClient>((ref) {
  return CoordinatorClient(authenticatedDio(ref));
});

/// The subjects the signed-in teacher coordinates this year, across their sections. Empty for
/// most teachers, which hides the Coordinator entry altogether.
final myCoordinatedSubjectsProvider =
    FutureProvider.autoDispose<CoordinatedSubjects>((ref) {
      return ref.watch(coordinatorClientProvider).fetchMySubjects();
    });
