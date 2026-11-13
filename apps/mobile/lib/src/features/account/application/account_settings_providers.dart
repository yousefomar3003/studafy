import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/generated/models/notification_preferences.dart';
import '../../../core/api/generated/models/notification_quiet_hours.dart';
import '../../../core/api/generated/models/session.dart';
import '../../../core/api/generated/models/update_notification_quiet_hours_request.dart';
import '../../../core/auth/auth_providers.dart';
import '../../../core/auth/authenticated_dio.dart';
import '../../../core/push/push_providers.dart';
import '../../../core/push/push_service.dart';
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

/// One (type, channel) switch to save.
typedef PreferenceChange = ({String type, String channel, bool enabled});

/// Saves switches (`PATCH /api/notification-preferences`) and returns the server's full, updated
/// matrix. Throws the API's error on refusal (e.g. 422 for a mandatory type).
///
/// The body is written by hand rather than through the generated request model: that model sends
/// every field it has, so a toggle would also send `"digest": null` (refused, 400) and
/// `"attendance_alert_threshold": null` (which clears a parent's own alert threshold).
final updateNotificationPreferencesProvider =
    Provider<
      Future<NotificationPreferences> Function(List<PreferenceChange> changes)
    >((ref) {
      final dio = authenticatedDio(ref);
      return (changes) async {
        final response = await dio.patch<Map<String, dynamic>>(
          '/api/notification-preferences',
          data: {
            'preferences': [
              for (final change in changes)
                {
                  'notification_type': change.type,
                  'channel': change.channel,
                  'enabled': change.enabled,
                },
            ],
          },
        );
        return NotificationPreferences.fromJson(response.data!);
      };
    });

/// The signed-in user's quiet hours (`GET /api/notification-preferences/quiet-hours`).
final notificationQuietHoursProvider =
    FutureProvider.autoDispose<NotificationQuietHours>((ref) {
      return ref
          .watch(apiClientProvider)
          .notifications
          .getNotificationQuietHours();
    });

/// Sets quiet hours (`HH:MM`), or turns them off with two nulls.
final updateQuietHoursProvider =
    Provider<
      Future<NotificationQuietHours> Function(String? start, String? end)
    >((ref) {
      final api = ref.watch(apiClientProvider);
      return (start, end) => api.notifications.updateNotificationQuietHours(
        body: UpdateNotificationQuietHoursRequest(start: start, end: end),
      );
    });

/// Puts a test notice in the inbox; the server pushes it to every phone this account is on.
final sendTestNotificationProvider = Provider<Future<void> Function()>((ref) {
  final api = ref.watch(apiClientProvider);
  return () async {
    await api.notifications.sendTestNotification();
  };
});

/// What this phone allows for the app's notifications. Refreshed when the screen comes back from
/// the Settings app.
final pushPermissionProvider = FutureProvider.autoDispose<PushPermission>((
  ref,
) {
  return ref.watch(pushServiceProvider).permissionStatus();
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
