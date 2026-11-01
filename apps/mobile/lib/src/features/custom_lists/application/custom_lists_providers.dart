import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/authenticated_dio.dart';
import '../../account/application/account_settings_providers.dart';
import '../data/custom_lists_client.dart';
import '../domain/custom_list.dart';

/// Whether these session roles hold `customList:use`: every school staff role, and SUPER_ADMIN
/// (mirrors ROLE_PERMISSIONS in packages/constants). Parents and students never see lists. Which
/// lists the user then reads is the API's, by each list's audience.
bool canUseCustomLists(Iterable<String> roles) =>
    holdsStaffRole(roles) || roles.contains('SUPER_ADMIN');

/// [CustomListsClient] on its own [authenticatedDio], as `ownStaffRecordClientProvider` is.
final customListsClientProvider = Provider<CustomListsClient>((ref) {
  return CustomListsClient(authenticatedDio(ref));
});

/// The lists the signed-in user may read (`GET /api/custom-lists`).
final customListsProvider = FutureProvider.autoDispose<List<CustomListSummary>>(
  (ref) {
    return ref.watch(customListsClientProvider).lists();
  },
);

/// One list and its columns (`GET /api/custom-lists/{listId}`).
final customListDetailProvider = FutureProvider.autoDispose
    .family<CustomListDetail, String>((ref, listId) {
      return ref.watch(customListsClientProvider).detail(listId);
    });

/// The list rows linked to a student, parent, member of staff or class, keyed by
/// `(subjectKind, subjectId)` (`GET /api/custom-lists/linked/{subjectKind}/{subjectId}`).
final linkedCustomListsProvider = FutureProvider.autoDispose
    .family<List<LinkedCustomList>, (String, String)>((ref, subject) {
      return ref
          .watch(customListsClientProvider)
          .linked(subject.$1, subject.$2);
    });
