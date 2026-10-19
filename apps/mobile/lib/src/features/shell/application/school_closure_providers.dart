import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/generated/models/current_school.dart';
import '../../../core/api/generated/models/school_closure_request.dart';
import '../../../core/auth/auth_providers.dart';

/// The signed-in user's own school (`GET /api/schools/current`) — its name is what the school
/// admin types to confirm closing it.
final currentSchoolProvider = FutureProvider.autoDispose<CurrentSchool>((ref) {
  return ref.watch(apiClientProvider).schools.getCurrentSchool();
});

/// Closes the signed-in admin's school (`POST /api/schools/current/closure`). Throws the API's
/// error (a `DioException` carrying an `ApiException`) on refusal.
final closeSchoolProvider =
    Provider<Future<void> Function(String confirmSchoolName)>((ref) {
      final api = ref.watch(apiClientProvider);
      return (confirmSchoolName) async {
        await api.schools.closeCurrentSchool(
          body: SchoolClosureRequest(confirmSchoolName: confirmSchoolName),
        );
      };
    });

/// The comparison form the API uses for the typed confirmation: trimmed and case-insensitive —
/// `normalizeSchoolName` in `apps/api/src/modules/tenancy/closure/service.ts`, which additionally
/// NFC-normalizes. The button enables when the server will accept the name; a rare Unicode-only
/// difference is still caught there and shown as a mismatch.
String normalizeSchoolName(String name) => name.trim().toLowerCase();
