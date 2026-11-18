import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/auth_providers.dart';
import '../../../core/auth/auth_state.dart';
import '../../../core/auth/authenticated_dio.dart';
import '../data/student_ai_client.dart';
import '../domain/student_ai_offer.dart';
import 'parent_providers.dart';

final studentAiClientProvider = Provider<StudentAiClient>((ref) {
  return StudentAiClient(authenticatedDio(ref));
});

/// Student AI for the signed-in parent's children at **this account's school**. A parent with
/// children at several schools has an account per school; each account's session sees only its
/// own school's offers. Keyed on the active account (it watches the auth status and the user id),
/// so switching accounts drops the previous school's offers and loads the new one's. Null when
/// signed out.
final studentAiOffersProvider = FutureProvider<StudentAiOffers?>((ref) async {
  if (ref.watch(authStatusProvider) != AuthStatus.authenticated) return null;
  if (ref.watch(parentUserIdProvider) == null) return null;
  return ref.watch(studentAiClientProvider).fetchOffers();
});
