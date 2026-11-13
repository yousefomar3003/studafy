import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/auth_providers.dart';
import '../../../core/auth/saved_account.dart';
import '../data/child_device_accounts_store.dart';

final childDeviceAccountsStoreProvider = Provider<ChildDeviceAccountsStore>(
  (ref) => ChildDeviceAccountsStore(),
);

/// "Add (child) to this phone" (POST /api/auth/guardian/children/{studentId}/session): the signed-in
/// parent's children whose own accounts are on this phone, as student record id -> child user id.
///
/// [add] asks the API for the child's own session using the parent's sign-in, and puts it in the
/// account switcher next to the parent's account -- set aside, not active -- so the child then opens
/// their own app with one tap, as themselves. Nothing is typed: no member ID, no password.
class ChildDeviceAccountsNotifier extends AsyncNotifier<Map<String, String>> {
  @override
  Future<Map<String, String>> build() async {
    // Rebuilt when the active account changes (switching passes through AuthStatus.loading).
    ref.watch(authStatusProvider);
    final parentUserId = ref.watch(authSessionProvider).userId;
    if (parentUserId == null) return const {};
    try {
      return await ref
          .read(childDeviceAccountsStoreProvider)
          .load(parentUserId);
    } catch (_) {
      // Unreadable preferences: every child shows "Add", which still works.
      return const {};
    }
  }

  /// Adds [studentId]'s own account to this phone and returns the child's user id. Throws the API
  /// error (a `DioException`) when the school, the link or the child's account refuses it.
  Future<String> add(String studentId) async {
    final response = await ref
        .read(apiClientProvider)
        .auth
        .createGuardianChildSession(studentId: studentId);
    final child = response.child;
    final auth = ref.read(authNotifierProvider.notifier);

    // The child's account may already be on the phone from an ordinary sign-in: end that older
    // session rather than leave it running behind the new one.
    final previous = await ref
        .read(savedAccountsProvider.notifier)
        .find(child.userId);
    if (previous != null) await auth.removeSavedAccount(child.userId);

    await auth.addSavedAccount(
      SavedAccount(
        userId: child.userId,
        accessToken: response.accessToken,
        refreshToken: response.refreshToken,
        sessionId: response.sessionId,
        roles: const ['STUDENT'],
        label: AccountLabel(
          displayName: child.displayName,
          schoolName: child.schoolName,
          memberIds: child.memberIds,
        ),
      ),
    );

    final parentUserId = ref.read(authSessionProvider).userId;
    if (parentUserId != null) {
      try {
        await ref
            .read(childDeviceAccountsStoreProvider)
            .remember(parentUserId, studentId, child.userId);
      } catch (_) {
        // The account is on the phone either way; only the "Open" shortcut would be missing.
      }
    }
    state = AsyncData({...?state.value, studentId: child.userId});
    return child.userId;
  }
}

final childDeviceAccountsProvider =
    AsyncNotifierProvider<ChildDeviceAccountsNotifier, Map<String, String>>(
      ChildDeviceAccountsNotifier.new,
    );

/// The child's user id when their own account is on this phone (in the account switcher), else
/// null -- the button then offers "Add (name) to this phone".
final childAccountOnPhoneProvider = Provider.family<String?, String>((
  ref,
  studentId,
) {
  final childUserId = ref.watch(childDeviceAccountsProvider).value?[studentId];
  if (childUserId == null) return null;
  final saved = ref.watch(savedAccountsProvider);
  return saved.any((account) => account.userId == childUserId)
      ? childUserId
      : null;
});
