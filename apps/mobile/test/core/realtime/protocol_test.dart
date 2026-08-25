import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/realtime/protocol.dart';

void main() {
  group('parseRoomKeyParts', () {
    test('parses a school room', () {
      final parsed = parseRoomKeyParts('school:123');
      expect(parsed, isA<ParsedRoomKey>());
      expect(parsed!.kind, RoomKind.school);
      expect(parsed.schoolId, '123');
    });

    test('parses a role room', () {
      final parsed = parseRoomKeyParts('school:123:role:STUDENT');
      expect(parsed!.kind, RoomKind.role);
      expect(parsed.schoolId, '123');
      expect(parsed.role, 'STUDENT');
    });

    test('parses a user room', () {
      final parsed = parseRoomKeyParts('school:123:user:user-1');
      expect(parsed!.kind, RoomKind.user);
      expect(parsed.schoolId, '123');
      expect(parsed.userId, 'user-1');
    });

    test('rejects an empty schoolId', () {
      expect(parseRoomKeyParts('school:'), isNull);
    });

    test('rejects a middle segment other than role/user', () {
      expect(parseRoomKeyParts('school:123:class:STUDENT'), isNull);
    });

    test('rejects a trailing empty segment', () {
      expect(parseRoomKeyParts('school:123:role:'), isNull);
    });

    test('rejects a foreign prefix', () {
      expect(parseRoomKeyParts('district:123'), isNull);
    });

    test('rejects the wrong number of segments', () {
      expect(parseRoomKeyParts('school:123:role'), isNull);
      expect(parseRoomKeyParts('school:123:role:STUDENT:extra'), isNull);
    });
  });

  group('EventEnvelope.tryParse', () {
    final validJson = <String, dynamic>{
      'id': '3fa85f64-5717-4562-b3fc-2c963f66afa6',
      'type': 'grades.published',
      'room': 'school:123:role:STUDENT',
      'payload': {'text': 'hello'},
      'publishedAt': '2026-07-09T12:00:00.000Z',
    };

    test('parses a valid envelope', () {
      final envelope = EventEnvelope.tryParse(validJson);
      expect(envelope, isNotNull);
      expect(envelope!.id, '3fa85f64-5717-4562-b3fc-2c963f66afa6');
      expect(envelope.type, 'grades.published');
      expect(envelope.room, 'school:123:role:STUDENT');
      expect(envelope.payload, {'text': 'hello'});
      expect(envelope.publishedAt, DateTime.parse('2026-07-09T12:00:00.000Z'));
    });

    test('rejects a non-UUID id', () {
      expect(
        EventEnvelope.tryParse({...validJson, 'id': 'not-a-uuid'}),
        isNull,
      );
    });

    test('rejects an empty type', () {
      expect(EventEnvelope.tryParse({...validJson, 'type': ''}), isNull);
    });

    test('rejects an invalid room key', () {
      expect(EventEnvelope.tryParse({...validJson, 'room': 'nope'}), isNull);
    });

    test('rejects an unparsable publishedAt', () {
      expect(
        EventEnvelope.tryParse({...validJson, 'publishedAt': 'not-a-date'}),
        isNull,
      );
    });

    test('rejects a missing field', () {
      final withoutId = Map<String, dynamic>.of(validJson)..remove('id');
      expect(EventEnvelope.tryParse(withoutId), isNull);
    });
  });

  group('parseIncomingMessage', () {
    test('parses system.joined', () {
      final message = parseIncomingMessage(
        '{"type":"system.joined","room":"school:123"}',
      );
      expect(message, isA<SystemJoined>());
      expect((message as SystemJoined).room, 'school:123');
    });

    test('parses system.left', () {
      final message = parseIncomingMessage(
        '{"type":"system.left","room":"school:123"}',
      );
      expect(message, isA<SystemLeft>());
    });

    test('parses system.error', () {
      final message = parseIncomingMessage(
        '{"type":"system.error","message":"nope"}',
      );
      expect(message, isA<SystemErrorMessage>());
      expect((message as SystemErrorMessage).message, 'nope');
    });

    test('parses system.reauth_required', () {
      final message = parseIncomingMessage(
        '{"type":"system.reauth_required","reason":"token expired"}',
      );
      expect(message, isA<SystemReauthRequired>());
      expect((message as SystemReauthRequired).reason, 'token expired');
    });

    test('parses a domain event envelope', () {
      final message = parseIncomingMessage('''
        {
          "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
          "type": "grades.published",
          "room": "school:123:role:STUDENT",
          "payload": {"a": 1},
          "publishedAt": "2026-07-09T12:00:00.000Z"
        }
      ''');
      expect(message, isA<EventEnvelope>());
    });

    test('drops malformed JSON', () {
      expect(parseIncomingMessage('{not json'), isNull);
    });

    test('drops JSON that is not an object', () {
      expect(parseIncomingMessage('[1,2,3]'), isNull);
    });

    test('drops an unknown message shape', () {
      expect(parseIncomingMessage('{"type":"system.unknown"}'), isNull);
    });
  });

  group('ClientMessage.toJson', () {
    test('join', () {
      expect(const JoinRoomMessage('school:123').toJson(), {
        'type': 'join',
        'room': 'school:123',
      });
    });

    test('leave', () {
      expect(const LeaveRoomMessage('school:123').toJson(), {
        'type': 'leave',
        'room': 'school:123',
      });
    });
  });
}
