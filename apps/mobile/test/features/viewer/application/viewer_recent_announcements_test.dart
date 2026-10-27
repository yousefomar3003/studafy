import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/api_client.dart';
import 'package:studafy_mobile/src/core/api/generated/announcements/announcements_client.dart';
import 'package:studafy_mobile/src/core/api/generated/models/announcement.dart';
import 'package:studafy_mobile/src/core/api/generated/models/announcement_audience_type.dart';
import 'package:studafy_mobile/src/core/api/generated/models/announcement_list.dart';
import 'package:studafy_mobile/src/core/api/generated/models/announcement_status.dart';
import 'package:studafy_mobile/src/core/api/generated/models/notification.dart';
import 'package:studafy_mobile/src/core/api/generated/models/notification_list.dart';
import 'package:studafy_mobile/src/core/api/generated/models/notification_notification_type.dart';
import 'package:studafy_mobile/src/core/api/generated/models/status16.dart';
import 'package:studafy_mobile/src/core/api/generated/models/unread_only.dart';
import 'package:studafy_mobile/src/core/api/generated/notifications/notifications_client.dart';
import 'package:studafy_mobile/src/core/auth/auth_providers.dart';
import 'package:studafy_mobile/src/features/viewer/application/viewer_providers.dart';
import 'package:studafy_mobile/src/features/viewer/domain/viewer_role.dart';

class _FakeAnnouncementsClient extends Fake implements AnnouncementsClient {
  int calls = 0;

  @override
  Future<AnnouncementList> listAnnouncements({
    String? cursor,
    Status16? status,
    int? limit = 20,
  }) async {
    calls++;
    final now = DateTime.utc(2026, 1, 1);
    return AnnouncementList(
      items: [
        Announcement(
          id: 'history-1',
          schoolId: 'school-1',
          createdBy: 'admin-1',
          createdByName: 'Principal',
          title: 'From history',
          body: 'Body',
          mandatory: false,
          audienceType: AnnouncementAudienceType.school,
          audienceRole: null,
          audienceClassId: null,
          audienceClassCode: null,
          status: AnnouncementStatus.published,
          scheduledAt: now,
          publishedAt: now,
          recipientCount: 1,
          notifiedCount: 1,
          createdAt: now,
          updatedAt: now,
        ),
      ],
      nextCursor: null,
    );
  }
}

class _FakeNotificationsClient extends Fake implements NotificationsClient {
  int calls = 0;

  @override
  Future<NotificationList> listNotifications({
    String? cursor,
    UnreadOnly? unreadOnly,
    int? limit = 20,
  }) async {
    calls++;
    Notification notification(String id, NotificationNotificationType type) =>
        Notification(
          id: id,
          schoolId: 'school-1',
          userId: 'user-1',
          notificationType: type,
          title: 'Inbox $id',
          body: 'Body',
          metadata: const {},
          readAt: null,
          createdAt: DateTime.utc(2026, 1, 1),
          updatedAt: DateTime.utc(2026, 1, 1),
        );
    return NotificationList(
      notifications: [
        notification('n1', NotificationNotificationType.announcement),
        notification('n2', NotificationNotificationType.gradePosted),
      ],
      nextCursor: null,
    );
  }
}

class _FakeApiClient extends Fake implements StudafyApiClient {
  @override
  final _FakeAnnouncementsClient announcements = _FakeAnnouncementsClient();
  @override
  final _FakeNotificationsClient notifications = _FakeNotificationsClient();
}

void main() {
  Future<(List<ViewerAnnouncementSummary>, _FakeApiClient)> load(
    ViewerRole role,
  ) async {
    final api = _FakeApiClient();
    final container = ProviderContainer(
      overrides: [
        apiClientProvider.overrideWithValue(api),
        viewerRoleProvider.overrideWithValue(role),
      ],
    );
    addTearDown(container.dispose);
    return (
      await container.read(viewerRecentAnnouncementsProvider.future),
      api,
    );
  }

  test('an admin viewer reads the school-wide announcement history', () async {
    final (items, api) = await load(ViewerRole.admin);

    expect(items.map((item) => item.title), ['From history']);
    expect(api.announcements.calls, 1);
    expect(api.notifications.calls, 0);
  });

  test(
    'a non-admin viewer reads announcements from its own inbox, never the admin history',
    () async {
      final (items, api) = await load(ViewerRole.finance);

      expect(items.map((item) => item.title), ['Inbox n1']);
      expect(api.announcements.calls, 0);
      expect(api.notifications.calls, 1);
    },
  );
}
