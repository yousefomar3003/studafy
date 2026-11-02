import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/features/messaging/domain/messaging.dart';

import '../support.dart';

void main() {
  final t0 = DateTime.utc(2026, 3, 10, 9);

  group('mergeMessages', () {
    test('de-duplicates by id, the incoming copy winning', () {
      final merged = mergeMessages(
        [messageFixture('a', at: t0, body: 'old')],
        [messageFixture('a', at: t0, body: 'new')],
      );
      expect(merged.single.body, 'new');
    });

    test('sorts ascending by time, prepending an older page', () {
      final merged = mergeMessages(
        [messageFixture('c', at: t0.add(const Duration(minutes: 2)))],
        [
          messageFixture('a', at: t0),
          messageFixture('b', at: t0.add(const Duration(minutes: 1))),
        ],
      );
      expect(merged.map((m) => m.id), ['a', 'b', 'c']);
    });

    test('equal timestamps keep arrival order', () {
      final merged = mergeMessages(
        [messageFixture('x', at: t0)],
        [messageFixture('y', at: t0), messageFixture('z', at: t0)],
      );
      expect(merged.map((m) => m.id), ['x', 'y', 'z']);
    });
  });

  test('totalUnread sums every conversation', () {
    expect(
      totalUnread([
        conversationFixture(unread: 2),
        conversationFixture(id: 'c2', unread: 0),
        conversationFixture(id: 'c3', unread: 5),
      ]),
      7,
    );
  });

  test('counterpart / self follow the viewer', () {
    final conversation = conversationFixture();
    expect(
      conversation.counterpart(MessagingViewer.parent).name,
      'Rana Haddad',
    );
    expect(
      conversation.counterpart(MessagingViewer.teacher).name,
      'Bassel Fares',
    );
    expect(conversation.self(MessagingViewer.parent).id, parentUserId);
  });

  group('decodeHtmlEntities', () {
    test('decodes what the server sanitizer emits', () {
      expect(
        decodeHtmlEntities(
          'Tom &amp; Jerry &lt;b&gt; &quot;hi&quot; it&#39;s &#x27;ok&#x27;',
        ),
        'Tom & Jerry <b> "hi" it\'s \'ok\'',
      );
    });

    test('single pass: an escaped entity stays literal', () {
      expect(decodeHtmlEntities('&amp;lt;'), '&lt;');
    });

    test('leaves plain text, Arabic and unknown entities alone', () {
      expect(decodeHtmlEntities('مرحبا & أهلا'), 'مرحبا & أهلا');
      expect(decodeHtmlEntities('&bogus; &#xZZ;'), '&bogus; &#xZZ;');
    });

    test('message and preview bodies are decoded at parse time', () {
      final conversation = conversationFixture(lastBody: 'A &amp; B');
      expect(conversation.lastMessage!.body, 'A & B');
      final message = ChatMessage.fromJson({
        'id': 'm1',
        'conversation_id': 'conv-1',
        'sender_id': 'u1',
        'body': '1 &lt; 2',
        'created_at': '2026-03-10T09:00:00.000Z',
      });
      expect(message.body, '1 < 2');
    });
  });
  group('filterTeacherContacts', () {
    TeacherMessagingParent parent(String id, String name) =>
        TeacherMessagingParent(
          parentId: id,
          name: name,
          relationship: 'mother',
          conversationId: null,
        );
    final students = [
      TeacherMessagingStudent(
        id: 's1',
        name: 'Amir Fares',
        classes: const [],
        parents: [parent('p1', 'Lina Fares'), parent('p2', 'Bassel Fares')],
      ),
      TeacherMessagingStudent(
        id: 's2',
        name: 'Mira Khalil',
        classes: const [],
        parents: [parent('p3', 'Omar Khalil')],
      ),
    ];

    test('a blank query keeps everything', () {
      expect(filterTeacherContacts(students, '  '), same(students));
    });

    test('a student-name match keeps all of that student\'s parents', () {
      final result = filterTeacherContacts(students, 'amir');
      expect(result.single.id, 's1');
      expect(result.single.parents.map((p) => p.parentId), ['p1', 'p2']);
    });

    test('a parent-name match keeps only matching parents', () {
      final result = filterTeacherContacts(students, 'LINA');
      expect(result.single.id, 's1');
      expect(result.single.parents.map((p) => p.parentId), ['p1']);
    });

    test('no match drops every student', () {
      expect(filterTeacherContacts(students, 'zzz'), isEmpty);
    });
  });

  group('images, blocks, profile and reports', () {
    test(
      'a message parses its attachments in order; an image-only body stays empty',
      () {
        final message = ChatMessage.fromJson({
          'id': 'm1',
          'conversation_id': 'conv-1',
          'sender_id': teacherUserId,
          'body': '',
          'created_at': '2026-03-10T09:00:00.000Z',
          'attachments': [
            {
              'id': 'a1',
              'content_type': 'image/png',
              'size_bytes': 2048,
              'download_url': 'https://storage.test/a1',
              'download_url_expires_at': '2026-03-10T09:05:00.000Z',
            },
            {
              'id': 'a2',
              'content_type': 'image/heic',
              'size_bytes': 4096,
              'download_url': null,
              'download_url_expires_at': null,
            },
          ],
        });
        expect(message.body, isEmpty);
        expect(message.attachments.map((a) => a.id), ['a1', 'a2']);
        expect(message.attachments.first.contentType, 'image/png');
        expect(message.attachments.first.sizeBytes, 2048);
        expect(
          message.attachments.first.downloadUrl,
          'https://storage.test/a1',
        );
        expect(
          message.attachments.first.downloadUrlExpiresAt,
          DateTime.utc(2026, 3, 10, 9, 5),
        );
        expect(message.attachments.last.downloadUrl, isNull);
        expect(message.attachments.last.downloadUrlExpiresAt, isNull);
      },
    );

    test('a message without attachments (older payloads) parses to none', () {
      final message = ChatMessage.fromJson({
        'id': 'm1',
        'conversation_id': 'conv-1',
        'sender_id': teacherUserId,
        'body': 'Hi',
        'created_at': '2026-03-10T09:00:00.000Z',
      });
      expect(message.attachments, isEmpty);
    });

    test(
      'a conversation parses the block flags and the preview attachment count',
      () {
        final conversation = Conversation.fromJson(
          conversationJson(lastBody: '', attachmentCount: 3, blockedByMe: true),
        );
        expect(conversation.block.blockedByMe, isTrue);
        expect(conversation.block.hasBlockedMe, isFalse);
        expect(conversation.block.isBlocked, isTrue);
        expect(conversation.lastMessage!.attachmentCount, 3);

        final unblocked = Conversation.fromJson(conversationJson());
        expect(unblocked.block, BlockState.none);
        expect(unblocked.block.isBlocked, isFalse);
      },
    );

    test('a teacher profile parses classes and subjects', () {
      final profile = ParticipantProfile.fromJson({
        'user_id': teacherUserId,
        'name': 'Rana Haddad',
        'role': 'teacher',
        'blocked_by_me': false,
        'has_blocked_me': true,
        'classes': [
          {
            'id': 'k1',
            'code': '7A',
            'course_name': 'Math 7',
            'subject_name': 'Mathematics',
          },
          {'id': 'k2', 'code': '7B', 'course_name': null, 'subject_name': null},
        ],
        'subjects': ['Mathematics', 'Physics'],
        'relationship': null,
        'children': <Object?>[],
      });
      expect(profile.role, ProfileRole.teacher);
      expect(profile.block.hasBlockedMe, isTrue);
      expect(profile.classes.map((c) => c.label), [
        '7A · Math 7 · Mathematics',
        '7B',
      ]);
      expect(profile.subjects, ['Mathematics', 'Physics']);
      expect(profile.relationship, isNull);
      expect(profile.children, isEmpty);
    });

    test('a parent profile parses the relationship and children', () {
      final profile = ParticipantProfile.fromJson({
        'user_id': parentUserId,
        'name': 'Bassel Fares',
        'role': 'parent',
        'blocked_by_me': true,
        'has_blocked_me': false,
        'classes': <Object?>[],
        'subjects': <Object?>[],
        'relationship': 'father',
        'children': [
          {
            'id': 'child-1',
            'name': 'Amir',
            'relationship': 'father',
            'is_conversation_student': true,
            'classes': [
              {'id': 'k1', 'code': '7A', 'course_name': 'Math 7'},
            ],
          },
          {
            'id': 'child-2',
            'name': 'Lina',
            'relationship': 'father',
            'is_conversation_student': false,
            'classes': <Object?>[],
          },
        ],
      });
      expect(profile.role, ProfileRole.parent);
      expect(profile.block.blockedByMe, isTrue);
      expect(profile.relationship, 'father');
      expect(
        relationshipKeyOf(profile.relationship),
        'messaging.relationship.father',
      );
      expect(relationshipKeyOf(null), 'messaging.relationship.parent');
      expect(profile.children.map((c) => c.name), ['Amir', 'Lina']);
      expect(profile.children.first.isConversationStudent, isTrue);
      expect(profile.children.first.classes.single.courseName, 'Math 7');
      expect(profile.children.last.classes, isEmpty);
    });

    test(
      'a report result carries the report id and the block flags after it',
      () {
        final result = ReportResult.fromJson({
          'report': {'id': 'r1', 'status': 'pending'},
          'block': {'blocked_by_me': true, 'has_blocked_me': false},
        });
        expect(result.reportId, 'r1');
        expect(
          result.block,
          const BlockState(blockedByMe: true, hasBlockedMe: false),
        );
      },
    );

    test('report reasons use the API wire values', () {
      expect(ReportReason.values.map((r) => r.wire), [
        'harassment',
        'inappropriate',
        'spam',
        'safety_concern',
        'other',
      ]);
    });
  });
}
