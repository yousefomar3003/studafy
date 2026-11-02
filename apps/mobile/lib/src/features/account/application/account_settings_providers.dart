import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/generated/models/notification_preference_update.dart';
import '../../../core/api/generated/models/notification_preferences.dart';
import '../../../core/api/generated/models/session.dart';
import '../../../core/api/generated/models/update_notification_preferences_request.dart';
import '../../../core/auth/auth_providers.dart';
import '../../../core/auth/authenticated_dio.dart';
import '../data/own_staff_record_client.dart';
import '../domain/own_staff_record.dart';

/// Every live session of the signed-in user (`GET /api/auth/sessions`), this device's first, then
/// the most recently issued.
final signedInSessionsProvider = FutureProvider.autoDispose<List<Session>>((
  ref,
) async {
  final sessions =
      (await ref.watch(apiClientProvider).auth.listSessions()).sessions;
  final currentId = ref.watch(authSessionProvider).sessionId;
  return [...sessions]..sort((a, b) {
    if (a.id == currentId) return -1;
    if (b.id == currentId) return 1;
    return b.issuedAt.compareTo(a.issuedAt);
  });
});

/// Ends one other session (`DELETE /api/auth/sessions/{id}`), then reloads the list.
final signOutSessionProvider =
    Provider<Future<void> Function(String sessionId)>((ref) {
      final api = ref.watch(apiClientProvider);
      return (sessionId) async {
        await api.auth.revokeSession(sessionId: sessionId);
        ref.invalidate(signedInSessionsProvider);
      };
    });

/// Ends every session but this device's own, one `DELETE /api/auth/sessions/{id}` each — the
/// bulk `revoke-others` route needs the raw refresh token, which never leaves [AuthSession].
final signOutOtherSessionsProvider =
    Provider<Future<void> Function(List<Session>)>((ref) {
      final api = ref.watch(apiClientProvider);
      final currentId = ref.watch(authSessionProvider).sessionId;
      return (sessions) async {
        try {
          for (final session in sessions) {
            if (session.id == currentId) continue;
            await api.auth.revokeSession(sessionId: session.id);
          }
        } finally {
          ref.invalidate(signedInSessionsProvider);
        }
      };
    });

/// The signed-in user's per-type, per-channel notification matrix (`GET /api/notification-preferences`).
final accountNotificationPreferencesProvider =
    FutureProvider.autoDispose<NotificationPreferences>((ref) {
      return ref
          .watch(apiClientProvider)
          .notifications
          .getNotificationPreferences();
    });

/// Saves one changed cell (`PATCH /api/notification-preferences`) and returns the server's full,
/// updated matrix. Throws the API's error on refusal (e.g. 422 for a mandatory type).
final updateNotificationPreferenceProvider =
    Provider<
      Future<NotificationPreferences> Function(NotificationPreferenceUpdate)
    >((ref) {
      final api = ref.watch(apiClientProvider);
      return (update) => api.notifications.updateNotificationPreferences(
        body: UpdateNotificationPreferencesRequest(preferences: [update]),
      );
    });

/// The roles that make someone a member of the school's staff, and so the subject of a staff
/// record they can read (mirrors `SCHOOL_STAFF_ROLES` in packages/constants).
const schoolStaffRoleClaims = {
  'ORG_ADMIN',
  'PRINCIPAL',
  'ATTENDANCE_OFFICER',
  'FINANCE',
  'INSTRUCTOR',
};

/// Whether these session roles include a staff role, so Profile offers "My staff record".
bool holdsStaffRole(Iterable<String> roles) =>
    roles.any(schoolStaffRoleClaims.contains);

/// [OwnStaffRecordClient] on its own [authenticatedDio], as `academicResultsClientProvider` is.
final ownStaffRecordClientProvider = Provider<OwnStaffRecordClient>((ref) {
  return OwnStaffRecordClient(authenticatedDio(ref));
});

/// The signed-in member of staff's own record (`GET /api/me/staff-record`).
final ownStaffRecordProvider = FutureProvider.autoDispose<OwnStaffRecord>((
  ref,
) {
  return ref.watch(ownStaffRecordClientProvider).fetch();
});

/// A short-lived download URL for one of the staff member's own documents. Not a cached provider:
/// the URL expires within minutes, so it is fetched each time the file is opened.
final ownStaffRecordDocumentUrlProvider =
    Provider<Future<Uri> Function(String fieldId)>((ref) {
      final client = ref.watch(ownStaffRecordClientProvider);
      return client.documentUrl;
    });
