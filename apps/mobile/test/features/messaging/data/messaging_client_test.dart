import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/features/messaging/data/messaging_client.dart';

import '../support.dart';

/// Answers each request from [respond] and records what was sent.
class _Adapter implements HttpClientAdapter {
  _Adapter(this.respond);

  final (int, Object?) Function(RequestOptions options) respond;
  final requests = <RequestOptions>[];

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    requests.add(options);
    final (status, body) = respond(options);
    return ResponseBody.fromString(
      body == null ? '' : jsonEncode(body),
      status,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}

(MessagingClient, _Adapter) _client(
  (int, Object?) Function(RequestOptions) respond,
) {
  final adapter = _Adapter(respond);
  return (MessagingClient(Dio()..httpClientAdapter = adapter), adapter);
}

void main() {
  test(
    'contacts: student-scoped, parses classes and the existing conversation',
    () async {
      final (client, adapter) = _client(
        (_) => (
          200,
          {
            'contacts': [
              {
                'teacher_id': 't1',
                'name': 'Rana Haddad',
                'classes': [
                  {'id': 'c1', 'code': 'SCI-7A', 'course_name': 'Science'},
                  {'id': 'c2', 'code': 'MATH-7A', 'course_name': null},
                ],
                'conversation_id': 'conv-1',
              },
              {
                'teacher_id': 't2',
                'name': 'Omar',
                'classes': [],
                'conversation_id': null,
              },
            ],
          },
        ),
      );

      final contacts = await client.fetchContacts('child-1');

      expect(adapter.requests.single.path, '/api/messaging/contacts');
      expect(adapter.requests.single.queryParameters, {
        'student_id': 'child-1',
      });
      expect(contacts.first.classes.map((c) => c.label), [
        'Science',
        'MATH-7A',
      ]);
      expect(contacts.first.conversationId, 'conv-1');
      expect(contacts.last.conversationId, isNull);
    },
  );

  test(
    'conversations: optional student filter, parses previews and unread',
    () async {
      final (client, adapter) = _client(
        (_) => (
          200,
          {
            'conversations': [
              conversationJson(unread: 3),
              conversationJson(id: 'c2', lastBody: null),
            ],
          },
        ),
      );

      final all = await client.listConversations();
      await client.listConversations(studentId: 'child-1');

      expect(adapter.requests.first.queryParameters, isEmpty);
      expect(adapter.requests.last.queryParameters, {'student_id': 'child-1'});
      expect(all.first.unreadCount, 3);
      expect(all.first.teacher.name, 'Rana Haddad');
      expect(all.first.lastMessage!.body, 'See you tomorrow');
      expect(all.last.lastMessage, isNull);
    },
  );

  test(
    'start conversation posts student and teacher and unwraps the conversation',
    () async {
      final (client, adapter) = _client(
        (_) => (201, {'conversation': conversationJson()}),
      );

      final conversation = await client.startConversation(
        studentId: 'child-1',
        teacherId: 't1',
      );

      expect(adapter.requests.single.method, 'POST');
      expect(adapter.requests.single.path, '/api/messaging/conversations');
      expect(adapter.requests.single.data, {
        'student_id': 'child-1',
        'teacher_id': 't1',
      });
      expect(conversation.id, 'conv-1');
    },
  );

  test('teacher contacts: students with their classes and parents', () async {
    final (client, adapter) = _client(
      (_) => (
        200,
        {
          'students': [
            {
              'id': 'child-1',
              'name': 'Amir',
              'classes': [
                {'id': 'c1', 'code': 'SCI-7A', 'course_name': 'Science'},
              ],
              'parents': [
                {
                  'parent_id': 'p1',
                  'name': 'Lina Fares',
                  'relationship': 'mother',
                  'conversation_id': null,
                },
                {
                  'parent_id': 'p2',
                  'name': 'Bassel Fares',
                  'relationship': 'something_new',
                  'conversation_id': 'conv-1',
                },
              ],
            },
          ],
        },
      ),
    );

    final students = await client.fetchTeacherContacts();

    expect(adapter.requests.single.path, '/api/messaging/teacher-contacts');
    expect(adapter.requests.single.queryParameters, isEmpty);
    final student = students.single;
    expect(student.classes.single.label, 'Science');
    expect(
      student.parents.first.relationshipKey,
      'messaging.relationship.mother',
    );
    expect(student.parents.first.conversationId, isNull);
    // An enum value this build does not know falls back to the generic label.
    expect(
      student.parents.last.relationshipKey,
      'messaging.relationship.parent',
    );
    expect(student.parents.last.conversationId, 'conv-1');
  });

  test('teacher start conversation posts student and parent', () async {
    final (client, adapter) = _client(
      (_) => (201, {'conversation': conversationJson()}),
    );

    final conversation = await client.startTeacherConversation(
      studentId: 'child-1',
      parentId: 'p1',
    );

    expect(adapter.requests.single.method, 'POST');
    expect(
      adapter.requests.single.path,
      '/api/messaging/teacher-conversations',
    );
    expect(adapter.requests.single.data, {
      'student_id': 'child-1',
      'parent_id': 'p1',
    });
    expect(conversation.id, 'conv-1');
  });

  test(
    'messages: limit / before / since as query params, has_more parsed',
    () async {
      final (client, adapter) = _client(
        (_) => (
          200,
          {
            'messages': [
              {
                'id': 'm1',
                'conversation_id': 'conv-1',
                'sender_id': 'u1',
                'body': 'Hi',
                'created_at': '2026-03-10T09:00:00.000Z',
              },
            ],
            'has_more': true,
          },
        ),
      );

      final page = await client.listMessages('conv-1', limit: 30, before: 'm9');
      await client.listMessages('conv-1', since: DateTime.utc(2026, 3, 10, 9));

      expect(
        adapter.requests.first.path,
        '/api/messaging/conversations/conv-1/messages',
      );
      expect(adapter.requests.first.queryParameters, {
        'limit': 30,
        'before': 'm9',
      });
      expect(adapter.requests.last.queryParameters, {
        'since': '2026-03-10T09:00:00.000Z',
      });
      expect(page.hasMore, isTrue);
      expect(page.messages.single.createdAt, DateTime.utc(2026, 3, 10, 9));
    },
  );

  test('send posts the body; read posts and accepts 204', () async {
    final (client, adapter) = _client((options) {
      if (options.path.endsWith('/read')) return (204, null);
      return (
        201,
        {
          'message': {
            'id': 'm2',
            'conversation_id': 'conv-1',
            'sender_id': 'u1',
            'body': 'Thanks',
            'created_at': '2026-03-10T09:01:00.000Z',
          },
        },
      );
    });

    final sent = await client.sendMessage('conv-1', 'Thanks');
    await client.markRead('conv-1');

    expect(adapter.requests.first.data, {'body': 'Thanks'});
    expect(sent.id, 'm2');
    expect(adapter.requests.last.method, 'POST');
    expect(
      adapter.requests.last.path,
      '/api/messaging/conversations/conv-1/read',
    );
  });
}
