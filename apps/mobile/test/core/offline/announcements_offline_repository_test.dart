import 'package:dio/dio.dart';
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/generated/models/notification.dart';
import 'package:studafy_mobile/src/core/api/generated/models/notification_list.dart';
import 'package:studafy_mobile/src/core/api/generated/models/notification_notification_type.dart';
import 'package:studafy_mobile/src/core/api/generated/models/unread_only.dart';
import 'package:studafy_mobile/src/core/api/generated/notifications/notifications_client.dart';
import 'package:studafy_mobile/src/core/offline/announcements_offline_repository.dart';
import 'package:studafy_mobile/src/core/offline/cached_value.dart';
import 'package:studafy_mobile/src/core/offline/offline_database.dart';

/// Only `listNotifications` is stubbed — any other call (and in particular nothing here can
/// reach the admin-only `GET /api/announcements`) fails loudly via [Fake].
class _FakeNotificationsClient extends Fake implements NotificationsClient {
  _FakeNotificationsClient(this.handler);

  Future<NotificationList> Function() handler;
  final List<int?> requestedLimits = [];

  @override
  Future<NotificationList> listNotifications({
    String? cursor,
    UnreadOnly? unreadOnly,
    int? limit = 20,
  }) {
    requestedLimits.add(limit);
    return handler();
  }
}

Notification _notification(
  String id,
  NotificationNotificationType type,
  DateTime createdAt,
) {
  return Notification(
    id: id,
    schoolId: 'school-1',
    userId: 'student-1',
    notificationType: type,
    title: 'Title $id',
    body: 'Body $id',
    metadata: const {'announcement_id': 'a-1', 'route': '/announcements'},
    readAt: null,
    createdAt: createdAt,
    updatedAt: createdAt,
  );
}

void main() {
  late OfflineDatabase database;

  setUp(() => database = OfflineDatabase(NativeDatabase.memory()));
  tearDown(() => database.close());

  test(
    'feeds announcements from the inbox, filtered to announcement types, newest first',
    () async {
      final client = _FakeNotificationsClient(
        () async => NotificationList(
          notifications: [
            _notification(
              'old',
              NotificationNotificationType.announcement,
              DateTime.utc(2026, 1, 1),
            ),
            _notification(
              'grade',
              NotificationNotificationType.gradePosted,
              DateTime.utc(2026, 1, 3),
            ),
            _notification(
              'mandatory',
              NotificationNotificationType.adminAnnouncement,
              DateTime.utc(2026, 1, 2),
            ),
          ],
          nextCursor: null,
        ),
      );
      final repo = AnnouncementsOfflineRepository(
        database: database,
        client: client,
      );

      final values = await repo.feed().toList();

      expect(values, hasLength(1));
      expect(values.single.source, CacheSource.network);
      expect(values.single.data.map((n) => n.id), ['mandatory', 'old']);
      expect(isMandatoryAnnouncement(values.single.data.first), isTrue);
      expect(isMandatoryAnnouncement(values.single.data.last), isFalse);
      expect(client.requestedLimits, [100]);
    },
  );

  test(
    'serves the cached feed first, and falls back to it when the refresh fails',
    () async {
      final client = _FakeNotificationsClient(
        () async => NotificationList(
          notifications: [
            _notification(
              'a1',
              NotificationNotificationType.announcement,
              DateTime.utc(2026, 1, 1),
            ),
          ],
          nextCursor: null,
        ),
      );
      final repo = AnnouncementsOfflineRepository(
        database: database,
        client: client,
      );
      await repo.feed().toList();

      client.handler = () => Future.error(
        DioException.connectionError(
          requestOptions: RequestOptions(path: '/api/notifications'),
          reason: 'offline',
        ),
      );
      final values = await repo.feed().toList();

      expect(values.map((value) => value.source), [
        CacheSource.cache,
        CacheSource.cache,
      ]);
      expect(values.last.data.single.id, 'a1');
      expect(values.last.data.single.title, 'Title a1');
    },
  );

  test(
    'surfaces the error when the refresh fails with nothing cached',
    () async {
      final client = _FakeNotificationsClient(
        () => Future.error(
          DioException.connectionError(
            requestOptions: RequestOptions(path: '/api/notifications'),
            reason: 'offline',
          ),
        ),
      );
      final repo = AnnouncementsOfflineRepository(
        database: database,
        client: client,
      );

      expect(repo.feed().toList(), throwsA(isA<DioException>()));
    },
  );
}
