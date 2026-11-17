/// A student's AI study sources besides their classes' study materials: one of their assignments,
/// or a file or photo of their own (`/api/ai/students/{studentId}/sources`).
///
/// A source's [id] is a material id on the server, so every AI tool takes it exactly where it
/// takes a study material.
library;

/// Where the source came from — the three tabs of the source picker.
enum AiSourceKind { material, assignment, personal }

/// The pipeline state of a source, from the server's `status` (the material pipeline's states).
enum AiSourceStatus {
  /// Waiting for the file to finish uploading.
  uploading,

  /// In the malware scan.
  scanning,

  /// Being read (and OCR'd, for a photo).
  processing,

  ready,
  failed,

  /// The scan found something harmful; the file was removed.
  blocked;

  static AiSourceStatus fromWire(String? wire) => switch (wire) {
    'uploaded' => uploading,
    'scanning' => scanning,
    'queued' || 'processing' => processing,
    'ready' => ready,
    'quarantined' => blocked,
    _ => failed,
  };

  /// Still moving through the pipeline: worth checking again shortly.
  bool get inFlight => this == uploading || this == scanning || this == processing;
}

/// What a source picker hands back: the id an AI tool takes, and a title to show for it.
class AiSourceChoice {
  const AiSourceChoice({required this.id, required this.title, required this.kind});

  final String id;
  final String title;
  final AiSourceKind kind;

  @override
  bool operator ==(Object other) => other is AiSourceChoice && other.id == id;

  @override
  int get hashCode => id.hashCode;
}

/// One file or photo the student uploaded.
class AiPersonalSource {
  const AiPersonalSource({
    required this.id,
    required this.title,
    required this.mimeType,
    required this.sizeBytes,
    required this.status,
    required this.hasText,
    required this.createdAt,
    this.fileName,
  });

  factory AiPersonalSource.fromJson(Map<String, dynamic> json) => AiPersonalSource(
    id: json['id'] as String? ?? '',
    title: json['title'] as String? ?? '',
    fileName: json['original_file_name'] as String?,
    mimeType: json['mime_type'] as String? ?? '',
    sizeBytes: (json['size_bytes'] as num?)?.toInt() ?? 0,
    status: AiSourceStatus.fromWire(json['status'] as String?),
    hasText: json['has_text'] as bool? ?? false,
    createdAt: DateTime.tryParse(json['created_at'] as String? ?? '') ?? DateTime(1970),
  );

  final String id;
  final String title;
  final String? fileName;
  final String mimeType;
  final int sizeBytes;
  final AiSourceStatus status;

  /// Ingestion found text in it. A ready photo with no readable text can't be used.
  final bool hasText;
  final DateTime createdAt;

  bool get isPhoto => mimeType.startsWith('image/');

  /// Ready, with text to work from: the AI tools can use it.
  bool get usable => status == AiSourceStatus.ready && hasText;

  AiSourceChoice get choice => AiSourceChoice(id: id, title: title, kind: AiSourceKind.personal);
}

/// How much of their own allowance a student has used.
class AiSourceUsage {
  const AiSourceUsage({
    required this.count,
    required this.bytes,
    required this.maxCount,
    required this.maxBytes,
    required this.maxFileBytes,
    required this.retentionDays,
  });

  factory AiSourceUsage.fromJson(Map<String, dynamic> json) => AiSourceUsage(
    count: (json['count'] as num?)?.toInt() ?? 0,
    bytes: (json['bytes'] as num?)?.toInt() ?? 0,
    maxCount: (json['max_count'] as num?)?.toInt() ?? 0,
    maxBytes: (json['max_bytes'] as num?)?.toInt() ?? 0,
    maxFileBytes: (json['max_file_bytes'] as num?)?.toInt() ?? 0,
    retentionDays: (json['retention_days'] as num?)?.toInt() ?? 0,
  );

  static const empty = AiSourceUsage(
    count: 0,
    bytes: 0,
    maxCount: 0,
    maxBytes: 0,
    maxFileBytes: 0,
    retentionDays: 0,
  );

  final int count;
  final int bytes;
  final int maxCount;
  final int maxBytes;
  final int maxFileBytes;
  final int retentionDays;

  bool get full => maxCount > 0 && count >= maxCount;

  /// Retention in whole months, for "kept for 12 months".
  int get retentionMonths => (retentionDays / 30.4).round();
}

/// The student's own files and photos, and their allowance.
class AiPersonalSources {
  const AiPersonalSources({required this.sources, required this.usage});

  factory AiPersonalSources.fromJson(Map<String, dynamic> json) => AiPersonalSources(
    sources: [
      for (final item in (json['sources'] as List?) ?? const [])
        if (item is Map<String, dynamic>) AiPersonalSource.fromJson(item),
    ],
    usage: json['usage'] is Map<String, dynamic>
        ? AiSourceUsage.fromJson(json['usage'] as Map<String, dynamic>)
        : AiSourceUsage.empty,
  );

  final List<AiPersonalSource> sources;
  final AiSourceUsage usage;

  bool get anyInFlight => sources.any((source) => source.status.inFlight);
}

/// One of the student's assignments, as a possible source.
class AiAssignmentSource {
  const AiAssignmentSource({
    required this.assignmentId,
    required this.title,
    required this.dueAt,
    required this.attachmentCount,
    required this.aiEnabled,
    this.classCode,
    this.sourceId,
    this.sourceStatus,
  });

  factory AiAssignmentSource.fromJson(Map<String, dynamic> json) => AiAssignmentSource(
    assignmentId: json['assignment_id'] as String? ?? '',
    title: json['title'] as String? ?? '',
    classCode: json['class_code'] as String?,
    dueAt: DateTime.tryParse(json['due_at'] as String? ?? '') ?? DateTime(1970),
    attachmentCount: (json['attachment_count'] as num?)?.toInt() ?? 0,
    aiEnabled: json['ai_enabled'] as bool? ?? false,
    sourceId: json['source_id'] as String?,
    sourceStatus: json['source_status'] == null
        ? null
        : AiSourceStatus.fromWire(json['source_status'] as String?),
  );

  final String assignmentId;
  final String title;
  final String? classCode;
  final DateTime dueAt;
  final int attachmentCount;

  /// False when the school turned the AI study tools off for the assignment's class.
  final bool aiEnabled;

  /// The assignment's source, once it was built the first time.
  final String? sourceId;
  final AiSourceStatus? sourceStatus;

  AiAssignmentSource withSource(AiPreparedSource source) => AiAssignmentSource(
    assignmentId: assignmentId,
    title: title,
    classCode: classCode,
    dueAt: dueAt,
    attachmentCount: attachmentCount,
    aiEnabled: aiEnabled,
    sourceId: source.id,
    sourceStatus: source.status,
  );
}

/// A source as `GET .../sources/{id}` and `POST .../assignment-sources/{id}` return it.
class AiPreparedSource {
  const AiPreparedSource({
    required this.id,
    required this.title,
    required this.status,
    required this.hasText,
  });

  factory AiPreparedSource.fromJson(Map<String, dynamic> json) => AiPreparedSource(
    id: json['id'] as String? ?? '',
    title: json['title'] as String? ?? '',
    status: AiSourceStatus.fromWire(json['status'] as String?),
    hasText: json['has_text'] as bool? ?? false,
  );

  final String id;
  final String title;
  final AiSourceStatus status;
  final bool hasText;
}

/// The file formats the AI tools read, by file extension, with the content type each is uploaded
/// as. A photo from the camera or gallery is re-encoded to JPEG by the picker first.
const aiSourceContentTypes = <String, String>{
  'pdf': 'application/pdf',
  'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'jpg': 'image/jpeg',
  'jpeg': 'image/jpeg',
  'png': 'image/png',
};

/// The content type for [fileName], or null when the AI tools can't read that format.
String? aiSourceContentTypeFor(String fileName) {
  final dot = fileName.lastIndexOf('.');
  if (dot < 0 || dot == fileName.length - 1) return null;
  return aiSourceContentTypes[fileName.substring(dot + 1).toLowerCase()];
}
