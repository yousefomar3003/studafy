/// Client-side mirror of the realtime gateway's wire grammar
/// (`apps/realtime/src/protocol.ts`, narrative spec in `apps/realtime/docs/protocol.md`). The
/// gateway is the source of truth and validates everything it forwards; this is the client's own
/// defense against malformed or foreign frames, kept in step with that module. See
/// `apps/web/src/lib/realtime/protocol.ts` for the sibling web client's version of the same
/// grammar.
library;

import 'dart:convert';

/// A room key has one of three shapes, all sharing the `school:{schoolId}` prefix — the
/// multi-tenancy boundary. Only [parseRoomKeyParts] parses this grammar; whether a role is a real
/// platform role is the gateway's job, the client only carries the key back and forth.
enum RoomKind { school, role, user }

class ParsedRoomKey {
  const ParsedRoomKey.school(this.schoolId)
    : kind = RoomKind.school,
      role = null,
      userId = null;

  const ParsedRoomKey.role(this.schoolId, String this.role)
    : kind = RoomKind.role,
      userId = null;

  const ParsedRoomKey.user(this.schoolId, String this.userId)
    : kind = RoomKind.user,
      role = null;

  final RoomKind kind;
  final String schoolId;
  final String? role;
  final String? userId;
}

/// `school:{schoolId}`, `school:{schoolId}:role:{ROLE}`, or `school:{schoolId}:user:{userId}`.
/// A plain [String] on the wire and in this client — see `protocol.ts`'s `RoomKey` for why.
typedef RoomKey = String;

/// Parses a room key by splitting on `:` and validating structure only, matching the gateway and
/// web client's own parser. Returns `null` for anything else, including a well-formed key outside
/// these three shapes.
ParsedRoomKey? parseRoomKeyParts(String value) {
  final parts = value.split(':');
  if (parts.isEmpty ||
      parts[0] != 'school' ||
      parts.length < 2 ||
      parts[1].isEmpty) {
    return null;
  }
  final schoolId = parts[1];
  if (parts.length == 2) {
    return ParsedRoomKey.school(schoolId);
  }
  if (parts.length == 4 && parts[3].isNotEmpty) {
    if (parts[2] == 'role') {
      return ParsedRoomKey.role(schoolId, parts[3]);
    }
    if (parts[2] == 'user') {
      return ParsedRoomKey.user(schoolId, parts[3]);
    }
  }
  return null;
}

bool isValidRoomKey(String value) => parseRoomKeyParts(value) != null;

final RegExp _uuidPattern = RegExp(
  r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
);

/// Anything the gateway may send the client over the socket: a [SystemMessage] control-plane
/// ack/error, or an [EventEnvelope] domain event. The two are never mixed into one shape — they
/// mean different things and grow independently — but [parseIncomingMessage] hands back a single
/// sealed type so callers can `switch` on the concrete subtype.
sealed class IncomingMessage {
  const IncomingMessage();
}

/// Gateway -> client acks/errors for the control channel, distinct from domain event envelopes.
/// [SystemReauthRequired] always precedes a close with [reauthRequiredCloseCode].
sealed class SystemMessage extends IncomingMessage {
  const SystemMessage();
}

class SystemJoined extends SystemMessage {
  const SystemJoined(this.room);
  final RoomKey room;
}

class SystemLeft extends SystemMessage {
  const SystemLeft(this.room);
  final RoomKey room;
}

class SystemErrorMessage extends SystemMessage {
  const SystemErrorMessage(this.message);
  final String message;
}

class SystemReauthRequired extends SystemMessage {
  const SystemReauthRequired(this.reason);
  final String reason;
}

/// Domain event envelope the gateway fans out verbatim from a room's Redis channel. [room] is the
/// room key it was delivered on; [payload] is arbitrary event-specific data the client does not
/// interpret. [id] is unique per publish and is what the client dedups on.
class EventEnvelope extends IncomingMessage {
  const EventEnvelope({
    required this.id,
    required this.type,
    required this.room,
    required this.payload,
    required this.publishedAt,
  });

  final String id;
  final String type;
  final RoomKey room;
  final Object? payload;
  final DateTime publishedAt;

  static EventEnvelope? tryParse(Map<String, dynamic> json) {
    final id = json['id'];
    final type = json['type'];
    final room = json['room'];
    final publishedAt = json['publishedAt'];
    if (id is! String || !_uuidPattern.hasMatch(id)) {
      return null;
    }
    if (type is! String || type.isEmpty) {
      return null;
    }
    if (room is! String || !isValidRoomKey(room)) {
      return null;
    }
    if (publishedAt is! String) {
      return null;
    }
    final parsedDate = DateTime.tryParse(publishedAt);
    if (parsedDate == null) {
      return null;
    }
    return EventEnvelope(
      id: id,
      type: type,
      room: room,
      payload: json['payload'],
      publishedAt: parsedDate,
    );
  }
}

SystemMessage? _tryParseSystemMessage(Map<String, dynamic> json) {
  final type = json['type'];
  switch (type) {
    case 'system.joined':
      final room = json['room'];
      return room is String && isValidRoomKey(room) ? SystemJoined(room) : null;
    case 'system.left':
      final room = json['room'];
      return room is String && isValidRoomKey(room) ? SystemLeft(room) : null;
    case 'system.error':
      final message = json['message'];
      return message is String ? SystemErrorMessage(message) : null;
    case 'system.reauth_required':
      final reason = json['reason'];
      return reason is String ? SystemReauthRequired(reason) : null;
    default:
      return null;
  }
}

/// Client -> gateway control messages: join/leave a room beyond the home rooms granted at
/// handshake.
sealed class ClientMessage {
  const ClientMessage();
  Map<String, Object?> toJson();
}

class JoinRoomMessage extends ClientMessage {
  const JoinRoomMessage(this.room);
  final RoomKey room;

  @override
  Map<String, Object?> toJson() => {'type': 'join', 'room': room};
}

class LeaveRoomMessage extends ClientMessage {
  const LeaveRoomMessage(this.room);
  final RoomKey room;

  @override
  Map<String, Object?> toJson() => {'type': 'leave', 'room': room};
}

/// Close code the gateway uses when it closes a socket because its token expired mid-connection.
const int reauthRequiredCloseCode = 4401;

/// Parses and validates a raw text frame from the gateway. Returns `null` for malformed frames or
/// JSON that isn't a known message shape — the client logs and drops those rather than crashing,
/// matching the gateway's own validate-and-drop behavior. System messages are tried before event
/// envelopes: both are namespaced distinctly enough (`system.*` vs. a domain-event name) that
/// order doesn't matter for correctness, but system messages are the smaller, cheaper check.
IncomingMessage? parseIncomingMessage(String text) {
  Object? parsed;
  try {
    parsed = jsonDecode(text);
  } on FormatException {
    return null;
  }
  if (parsed is! Map<String, dynamic>) {
    return null;
  }
  final system = _tryParseSystemMessage(parsed);
  if (system != null) {
    return system;
  }
  return EventEnvelope.tryParse(parsed);
}
