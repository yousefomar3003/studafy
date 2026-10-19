/// Parent ↔ teacher messaging, as served by `/api/messaging`. Hand-parsed (snake_case JSON) —
/// the messaging endpoints are not part of the generated OpenAPI client.
///
/// Message bodies arrive HTML-escaped by the server's sanitizer (`&` → `&amp;`, `<` → `&lt;`,
/// …); they are decoded with [decodeHtmlEntities] at parse time, so everything above this layer
/// — display, de-duplication, matching a sent message — works on the text the user typed. Bodies
/// are sent raw; the server escapes them.
library;

/// The longest message body the API accepts, in characters.
const maxMessageLength = 2000;

/// The most images one message can carry.
const maxMessageAttachments = 4;

/// The largest image the API accepts for a message attachment: 10 MiB.
const maxMessageAttachmentBytes = 10 * 1024 * 1024;

/// The image types a message attachment may be.
const messageAttachmentContentTypes = {'image/jpeg', 'image/png', 'image/webp', 'image/heic'};

/// The longest report details the API accepts, in characters.
const maxReportDetailsLength = 1000;

/// Which side of a parent ↔ teacher conversation the signed-in user is on.
enum MessagingViewer { parent, teacher }

/// A person (or student) a conversation names: id plus display name.
class MessagingParty {
  const MessagingParty({required this.id, required this.name});

  factory MessagingParty.fromJson(Map<String, Object?> json) =>
      MessagingParty(id: json['id']! as String, name: (json['name'] as String?) ?? '');

  final String id;
  final String name;
}

/// The newest message of a conversation, as the list endpoint previews it.
class ConversationPreview {
  const ConversationPreview({
    required this.body,
    required this.senderId,
    required this.createdAt,
    this.attachmentCount = 0,
  });

  factory ConversationPreview.fromJson(Map<String, Object?> json) => ConversationPreview(
    body: decodeHtmlEntities(json['body']! as String),
    senderId: json['sender_id']! as String,
    createdAt: DateTime.parse(json['created_at']! as String),
    attachmentCount: (json['attachment_count'] as num?)?.toInt() ?? 0,
  );

  /// Empty for an image-only message.
  final String body;
  final String senderId;
  final DateTime createdAt;

  /// Images on the newest message.
  final int attachmentCount;
}

/// Who has blocked whom in one conversation, from the caller's side. While either is true the
/// API refuses sends (403 `MESSAGING_BLOCKED`); the history stays readable.
class BlockState {
  const BlockState({required this.blockedByMe, required this.hasBlockedMe});

  factory BlockState.fromJson(Map<String, Object?> json) => BlockState(
    blockedByMe: (json['blocked_by_me'] as bool?) ?? false,
    hasBlockedMe: (json['has_blocked_me'] as bool?) ?? false,
  );

  static const none = BlockState(blockedByMe: false, hasBlockedMe: false);

  /// The caller has blocked the other participant.
  final bool blockedByMe;

  /// The other participant has blocked the caller.
  final bool hasBlockedMe;

  /// Either side has blocked the other — sending is not possible.
  bool get isBlocked => blockedByMe || hasBlockedMe;

  BlockState copyWith({bool? blockedByMe, bool? hasBlockedMe}) => BlockState(
    blockedByMe: blockedByMe ?? this.blockedByMe,
    hasBlockedMe: hasBlockedMe ?? this.hasBlockedMe,
  );

  @override
  bool operator ==(Object other) =>
      other is BlockState && other.blockedByMe == blockedByMe && other.hasBlockedMe == hasBlockedMe;

  @override
  int get hashCode => Object.hash(blockedByMe, hasBlockedMe);
}

/// One parent ↔ teacher thread about one student.
class Conversation {
  const Conversation({
    required this.id,
    required this.student,
    required this.parent,
    required this.teacher,
    required this.lastMessage,
    required this.unreadCount,
    required this.updatedAt,
    this.block = BlockState.none,
  });

  factory Conversation.fromJson(Map<String, Object?> json) {
    final last = json['last_message'];
    return Conversation(
      id: json['id']! as String,
      student: MessagingParty.fromJson(_map(json['student'])),
      parent: MessagingParty.fromJson(_map(json['parent'])),
      teacher: MessagingParty.fromJson(_map(json['teacher'])),
      lastMessage: last == null ? null : ConversationPreview.fromJson(_map(last)),
      unreadCount: (json['unread_count'] as num?)?.toInt() ?? 0,
      updatedAt: DateTime.parse(json['updated_at']! as String),
      block: BlockState.fromJson(json),
    );
  }

  final String id;
  final MessagingParty student;
  final MessagingParty parent;
  final MessagingParty teacher;
  final ConversationPreview? lastMessage;
  final int unreadCount;
  final DateTime updatedAt;

  /// The block flags as of when this conversation was fetched.
  final BlockState block;

  /// The participant on the other side from [viewer].
  MessagingParty counterpart(MessagingViewer viewer) =>
      viewer == MessagingViewer.parent ? teacher : parent;

  /// The participant [viewer] is.
  MessagingParty self(MessagingViewer viewer) =>
      viewer == MessagingViewer.parent ? parent : teacher;
}

/// An image attached to a message. [downloadUrl] is a pre-signed GET that stops working at
/// [downloadUrlExpiresAt] (about five minutes after the fetch); a fresh one comes with the next
/// fetch of the message. Both are null when the deployment has no object storage configured.
class MessageAttachment {
  const MessageAttachment({
    required this.id,
    required this.contentType,
    required this.sizeBytes,
    required this.downloadUrl,
    required this.downloadUrlExpiresAt,
  });

  factory MessageAttachment.fromJson(Map<String, Object?> json) {
    final expires = json['download_url_expires_at'] as String?;
    return MessageAttachment(
      id: json['id']! as String,
      contentType: (json['content_type'] as String?) ?? 'image/jpeg',
      sizeBytes: (json['size_bytes'] as num?)?.toInt() ?? 0,
      downloadUrl: json['download_url'] as String?,
      downloadUrlExpiresAt: expires == null ? null : DateTime.parse(expires),
    );
  }

  final String id;
  final String contentType;
  final int sizeBytes;
  final String? downloadUrl;
  final DateTime? downloadUrlExpiresAt;
}

/// One message in a conversation. [body] is empty for an image-only message.
class ChatMessage {
  const ChatMessage({
    required this.id,
    required this.conversationId,
    required this.senderId,
    required this.body,
    required this.createdAt,
    this.attachments = const [],
  });

  factory ChatMessage.fromJson(Map<String, Object?> json) => ChatMessage(
    id: json['id']! as String,
    conversationId: json['conversation_id']! as String,
    senderId: json['sender_id']! as String,
    body: decodeHtmlEntities(json['body']! as String),
    createdAt: DateTime.parse(json['created_at']! as String),
    attachments: [
      for (final entry in (json['attachments'] as List<Object?>?) ?? const [])
        MessageAttachment.fromJson(_map(entry)),
    ],
  );

  final String id;
  final String conversationId;
  final String senderId;
  final String body;
  final DateTime createdAt;

  /// Attached images in display order (0–4).
  final List<MessageAttachment> attachments;
}

/// A pre-signed upload slot for one message image: PUT the bytes to [uploadUrl], then send the
/// message with [storageKey]. There is no confirm step — the send promotes the object.
class AttachmentUploadTicket {
  const AttachmentUploadTicket({
    required this.uploadUrl,
    required this.storageKey,
    required this.expiresAt,
  });

  factory AttachmentUploadTicket.fromJson(Map<String, Object?> json) {
    final expires = json['expires_at'] as String?;
    return AttachmentUploadTicket(
      uploadUrl: json['upload_url']! as String,
      storageKey: json['storage_key']! as String,
      expiresAt: expires == null ? null : DateTime.parse(expires),
    );
  }

  final String uploadUrl;
  final String storageKey;
  final DateTime? expiresAt;
}

/// The other participant's side of a thread, as the profile endpoint reports it.
enum ProfileRole { teacher, parent }

/// A class the teacher teaches the thread's child in.
class ProfileTeacherClass {
  const ProfileTeacherClass({
    required this.id,
    required this.code,
    required this.courseName,
    required this.subjectName,
  });

  factory ProfileTeacherClass.fromJson(Map<String, Object?> json) => ProfileTeacherClass(
    id: json['id']! as String,
    code: (json['code'] as String?) ?? '',
    courseName: json['course_name'] as String?,
    subjectName: json['subject_name'] as String?,
  );

  final String id;
  final String code;
  final String? courseName;
  final String? subjectName;

  /// "code · course · subject", skipping whatever is unknown.
  String get label =>
      [code, ?courseName, ?subjectName].where((part) => part.isNotEmpty).join(' · ');
}

/// One of a parent's children the viewing teacher teaches (or the thread's own child).
class ProfileChild {
  const ProfileChild({
    required this.id,
    required this.name,
    required this.relationship,
    required this.isConversationStudent,
    required this.classes,
  });

  factory ProfileChild.fromJson(Map<String, Object?> json) => ProfileChild(
    id: json['id']! as String,
    name: (json['name'] as String?) ?? '',
    relationship: (json['relationship'] as String?) ?? 'other',
    isConversationStudent: (json['is_conversation_student'] as bool?) ?? false,
    classes: [
      for (final entry in (json['classes'] as List<Object?>?) ?? const [])
        ContactClass.fromJson(_map(entry)),
    ],
  );

  final String id;
  final String name;
  final String relationship;
  final bool isConversationStudent;
  final List<ContactClass> classes;
}

/// The other participant of a conversation: who they are, how they relate to the child, and the
/// block flags. Teacher-only fields ([classes], [subjects]) and parent-only ones
/// ([relationship], [children]) are empty / null for the other role.
class ParticipantProfile {
  const ParticipantProfile({
    required this.userId,
    required this.name,
    required this.role,
    required this.block,
    this.classes = const [],
    this.subjects = const [],
    this.relationship,
    this.children = const [],
  });

  factory ParticipantProfile.fromJson(Map<String, Object?> json) => ParticipantProfile(
    userId: json['user_id']! as String,
    name: (json['name'] as String?) ?? '',
    role: json['role'] == 'parent' ? ProfileRole.parent : ProfileRole.teacher,
    block: BlockState.fromJson(json),
    classes: [
      for (final entry in (json['classes'] as List<Object?>?) ?? const [])
        ProfileTeacherClass.fromJson(_map(entry)),
    ],
    subjects: [
      for (final entry in (json['subjects'] as List<Object?>?) ?? const [])
        if (entry is String && entry.isNotEmpty) entry,
    ],
    relationship: json['relationship'] as String?,
    children: [
      for (final entry in (json['children'] as List<Object?>?) ?? const [])
        ProfileChild.fromJson(_map(entry)),
    ],
  );

  final String userId;
  final String name;
  final ProfileRole role;
  final BlockState block;
  final List<ProfileTeacherClass> classes;
  final List<String> subjects;
  final String? relationship;
  final List<ProfileChild> children;
}

/// Why a conversation or message is being reported; [wire] is the API's `reason_category`.
enum ReportReason {
  harassment('harassment'),
  inappropriate('inappropriate'),
  spam('spam'),
  safetyConcern('safety_concern'),
  other('other');

  const ReportReason(this.wire);

  final String wire;
}

/// The outcome of filing a report: the new report's id and the block flags after it (changed
/// when the report also blocked).
class ReportResult {
  const ReportResult({required this.reportId, required this.block});

  factory ReportResult.fromJson(Map<String, Object?> json) => ReportResult(
    reportId: _map(json['report'])['id']! as String,
    block: BlockState.fromJson(_map(json['block'])),
  );

  final String reportId;
  final BlockState block;
}

/// A page of messages, ascending by time, and whether older ones exist before it.
class ChatMessagePage {
  const ChatMessagePage({required this.messages, required this.hasMore});

  final List<ChatMessage> messages;
  final bool hasMore;
}

/// A class a teacher contact teaches the child in.
class ContactClass {
  const ContactClass({required this.id, required this.code, required this.courseName});

  factory ContactClass.fromJson(Map<String, Object?> json) => ContactClass(
    id: json['id']! as String,
    code: (json['code'] as String?) ?? '',
    courseName: json['course_name'] as String?,
  );

  final String id;
  final String code;
  final String? courseName;

  /// The course name when known, else the class code.
  String get label => courseName ?? code;
}

/// A teacher a parent can message about one child, and the conversation they already share, if
/// any.
class MessagingContact {
  const MessagingContact({
    required this.teacherId,
    required this.name,
    required this.classes,
    required this.conversationId,
  });

  factory MessagingContact.fromJson(Map<String, Object?> json) => MessagingContact(
    teacherId: json['teacher_id']! as String,
    name: (json['name'] as String?) ?? '',
    classes: [
      for (final entry in (json['classes'] as List<Object?>?) ?? const [])
        ContactClass.fromJson(_map(entry)),
    ],
    conversationId: json['conversation_id'] as String?,
  );

  final String teacherId;
  final String name;
  final List<ContactClass> classes;
  final String? conversationId;
}

/// A parent a teacher can message about one student, and the conversation they already share,
/// if any. [relationship] is the API's `app.parent_relationship` value (`mother`, `guardian`, …).
class TeacherMessagingParent {
  const TeacherMessagingParent({
    required this.parentId,
    required this.name,
    required this.relationship,
    required this.conversationId,
  });

  factory TeacherMessagingParent.fromJson(Map<String, Object?> json) => TeacherMessagingParent(
    parentId: json['parent_id']! as String,
    name: (json['name'] as String?) ?? '',
    relationship: (json['relationship'] as String?) ?? 'other',
    conversationId: json['conversation_id'] as String?,
  );

  final String parentId;
  final String name;
  final String relationship;
  final String? conversationId;

  /// The translation key naming [relationship]; unknown values fall back to "Parent".
  String get relationshipKey => relationshipKeyOf(relationship);
}

/// The translation key naming an `app.parent_relationship` value; null or unknown values fall
/// back to "Parent".
String relationshipKeyOf(String? relationship) => _knownRelationships.contains(relationship)
    ? 'messaging.relationship.$relationship'
    : 'messaging.relationship.parent';

const _knownRelationships = {
  'mother',
  'father',
  'guardian',
  'step_parent',
  'grandparent',
  'sibling',
  'other',
};

/// A student a teacher teaches, the teacher's classes they are in, and the parents the teacher
/// can message about them.
class TeacherMessagingStudent {
  const TeacherMessagingStudent({
    required this.id,
    required this.name,
    required this.classes,
    required this.parents,
  });

  factory TeacherMessagingStudent.fromJson(Map<String, Object?> json) => TeacherMessagingStudent(
    id: json['id']! as String,
    name: (json['name'] as String?) ?? '',
    classes: [
      for (final entry in (json['classes'] as List<Object?>?) ?? const [])
        ContactClass.fromJson(_map(entry)),
    ],
    parents: [
      for (final entry in (json['parents'] as List<Object?>?) ?? const [])
        TeacherMessagingParent.fromJson(_map(entry)),
    ],
  );

  final String id;
  final String name;
  final List<ContactClass> classes;
  final List<TeacherMessagingParent> parents;
}

/// [students] narrowed to [query] (case-insensitive, trimmed): a student whose name matches
/// keeps every parent; otherwise only the parents whose names match, and students left with none
/// are dropped. A blank query returns [students] unchanged.
List<TeacherMessagingStudent> filterTeacherContacts(
  List<TeacherMessagingStudent> students,
  String query,
) {
  final needle = query.trim().toLowerCase();
  if (needle.isEmpty) return students;
  final matches = <TeacherMessagingStudent>[];
  for (final student in students) {
    if (student.name.toLowerCase().contains(needle)) {
      matches.add(student);
      continue;
    }
    final parents = [
      for (final parent in student.parents)
        if (parent.name.toLowerCase().contains(needle)) parent,
    ];
    if (parents.isNotEmpty) {
      matches.add(
        TeacherMessagingStudent(
          id: student.id,
          name: student.name,
          classes: student.classes,
          parents: parents,
        ),
      );
    }
  }
  return matches;
}

/// Merges [incoming] into [existing]: de-duplicated by id (an incoming copy replaces the old
/// one) and sorted ascending by `createdAt`, ties keeping arrival order. Pure — used both for a
/// `since` poll overlapping what is already shown and for prepending an older page.
List<ChatMessage> mergeMessages(List<ChatMessage> existing, Iterable<ChatMessage> incoming) {
  final byId = <String, ChatMessage>{for (final message in existing) message.id: message};
  for (final message in incoming) {
    byId[message.id] = message;
  }
  final merged = byId.values.toList();
  // List.sort is not guaranteed stable; index-break ties so equal timestamps keep their order.
  final order = {for (final (index, message) in merged.indexed) message.id: index};
  merged.sort((a, b) {
    final byTime = a.createdAt.compareTo(b.createdAt);
    return byTime != 0 ? byTime : order[a.id]!.compareTo(order[b.id]!);
  });
  return merged;
}

/// Total unread messages across [conversations].
int totalUnread(Iterable<Conversation> conversations) =>
    conversations.fold(0, (sum, conversation) => sum + conversation.unreadCount);

const _namedEntities = {
  'amp': '&',
  'lt': '<',
  'gt': '>',
  'quot': '"',
  'apos': "'",
  'nbsp': '\u00A0',
};

final _entityPattern = RegExp(r'&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);');

/// Decodes the HTML entities the API's sanitizer emits — the named `&amp;` `&lt;` `&gt;`
/// `&quot;` `&apos;` `&nbsp;` and any decimal / hex numeric reference (`&#39;`, `&#x27;`) — in a
/// single pass, so `&amp;lt;` becomes the literal `&lt;` rather than `<`. Anything unrecognized
/// is left as is.
String decodeHtmlEntities(String input) {
  if (!input.contains('&')) return input;
  return input.replaceAllMapped(_entityPattern, (match) {
    final entity = match[1]!;
    if (entity.startsWith('#')) {
      final hex = entity.length > 1 && (entity[1] == 'x' || entity[1] == 'X');
      final code = int.tryParse(entity.substring(hex ? 2 : 1), radix: hex ? 16 : 10);
      if (code == null || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) {
        return match[0]!;
      }
      return String.fromCharCode(code);
    }
    return _namedEntities[entity] ?? match[0]!;
  });
}

Map<String, Object?> _map(Object? raw) => Map<String, Object?>.from(raw! as Map);
