import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/auth_providers.dart';
import '../../../core/auth/auth_state.dart';
import '../../../core/api/generated/models/account_deletion_confirmation.dart';
import '../../../core/api/generated/models/accept_legal_documents.dart';
import '../../../core/api/generated/models/account_profile.dart';
import '../../../core/api/generated/models/legal_acceptance_status.dart';
import '../../../core/config/legal_links.dart';
import '../../../core/di/app_providers.dart';
import '../domain/shell_role.dart';

/// The current session's role claims, or empty when not authenticated.
///
/// [AuthSession] itself isn't observable, so this reads through [authStatusProvider] — the
/// only thing that changes the session's roles (login, logout, restore-on-boot) also flips
/// that status — to know when to re-read [AuthSession.roles].
final sessionRolesProvider = Provider<List<String>>((ref) {
  final status = ref.watch(authStatusProvider);
  final session = ref.read(authSessionProvider);
  return status == AuthStatus.authenticated ? session.roles : const [];
});

/// The signed-in user's own profile (`GET /api/account/profile`): name and member IDs, for every
/// role. Null when signed out; callers read `.value`, so a failed load just hides those details.
final accountProfileProvider = FutureProvider<AccountProfile?>((ref) async {
  if (ref.watch(authStatusProvider) != AuthStatus.authenticated) return null;
  return ref.watch(apiClientProvider).account.getOwnAccountProfile();
});

/// Schedules deletion of the signed-in user's own account (`POST /api/account/deletion`) and
/// returns when it runs (14 days out). Member-password accounts pass their own member ID and
/// password; others pass nulls. Throws the API's error (a `DioException` carrying an
/// `ApiException`) on refusal.
final deleteOwnAccountProvider =
    Provider<Future<DateTime> Function({String? memberId, String? password})>((
      ref,
    ) {
      final api = ref.watch(apiClientProvider);
      return ({memberId, password}) async {
        final body = memberId == null && password == null
            ? null
            : AccountDeletionConfirmation(
                memberId: memberId,
                password: password,
              );
        return (await api.account.deleteOwnAccount(body: body)).scheduledFor;
      };
    });

/// Cancels the signed-in user's scheduled deletion (`DELETE /api/account/deletion`), then renews
/// the access token so the session leaves the cancel-only state, and reloads the profile.
final cancelAccountDeletionProvider = Provider<Future<void> Function()>((ref) {
  final api = ref.watch(apiClientProvider);
  final session = ref.watch(authSessionProvider);
  return () async {
    await api.account.cancelOwnAccountDeletion();
    await session.refresh();
    // Every screen that loaded during the cancel-only state cached a refusal: reload them all
    // (the profile included, which is built on the API client).
    ref.read(sessionDataEpochProvider.notifier).bump();
  };
});

/// Records that the signed-in user accepts the current Terms of Service and has read the Privacy
/// Policy (`POST /api/account/legal-acceptance`, the versions from the profile), then renews the
/// token — the old one still carries `legal_acceptance_pending` — and reloads the profile, so
/// [AppShell] shows the shell. Throws the API's error on refusal.
final acceptLegalDocumentsProvider =
    Provider<Future<void> Function(LegalAcceptanceStatus versions)>((ref) {
      final api = ref.watch(apiClientProvider);
      final session = ref.watch(authSessionProvider);
      return (versions) async {
        await api.account.acceptLegalDocuments(
          body: AcceptLegalDocuments(
            termsVersion: versions.termsVersion,
            privacyVersion: versions.privacyVersion,
          ),
        );
        await session.refresh();
        // Anything that loaded while acceptance was pending holds LEGAL_ACCEPTANCE_REQUIRED as a
        // cached error (the parent's children report did, which left attendance and messages
        // unloadable): reload every API-backed provider, the profile included.
        ref.read(sessionDataEpochProvider.notifier).bump();
      };
    });

/// The public deletion page, for a session that may not reach the signed-in deletion flow.
final publicAccountDeleteUrlProvider = Provider<Uri>((ref) {
  return buildPublicAccountDeleteUrl(
    webBaseUrl: ref.watch(appConfigProvider).webBaseUrl,
  );
});

/// The shell the current session resolves to. See [resolveShellRole].
final shellRoleProvider = Provider<ShellRole>((ref) {
  return resolveShellRole(ref.watch(sessionRolesProvider));
});

/// The external-browser link for account deletion. See [buildAccountDeleteUrl].
final accountDeleteUrlProvider = Provider<Uri>((ref) {
  return buildAccountDeleteUrl(
    webBaseUrl: ref.watch(appConfigProvider).webBaseUrl,
  );
});

/// The bottom-navigation tab the user last selected, as its destination's `labelKey` (e.g.
/// `shell.tabs.timetable`) — null until a tab is tapped (the shell opens on Home).
///
/// The shell keeps every visited tab mounted (`app_shell.dart`), so a tab body's own build runs
/// once; a tab that must re-sync whenever it is brought back into view (the timetable, which an
/// admin can re-approve at any time) `ref.listen`s to this instead.
class SelectedShellTabNotifier extends Notifier<String?> {
  @override
  String? build() => null;

  void select(String labelKey) => state = labelKey;
}

final selectedShellTabProvider =
    NotifierProvider<SelectedShellTabNotifier, String?>(
      SelectedShellTabNotifier.new,
    );
