/// Domain model for the exam mode item bank and its scoring report (ST-232, the mobile
/// counterpart to the API's ST-171): what `ExamClient.startExam` reveals once the timer begins,
/// and the per-topic weakness report `ExamClient.submitExam` returns once it's over.
///
/// Mirrors `quiz.dart`'s split between the wire shape (`data/exam_client.dart` parses it,
/// snake_case JSON keys and all) and this on-screen model.
library;

/// `mcq` | `short_answer` — see `apps/api/src/modules/ai/exam/grading.ts`'s `EXAM_ITEM_TYPES`,
/// the schema this mirrors. A separate type from `QuizQuestionType` even though the wire
/// spellings are identical: an exam item and a quiz question are the same shape by coincidence,
/// not by a real domain relationship (see that module's own doc comment for the API-side call).
enum ExamItemType { mcq, shortAnswer }

String examItemTypeToWire(ExamItemType type) => switch (type) {
  ExamItemType.mcq => 'mcq',
  ExamItemType.shortAnswer => 'short_answer',
};

/// The inverse of [examItemTypeToWire]. Unrecognized input falls back to [ExamItemType.mcq]
/// rather than throwing — this only ever reads a value the server already wrote, never
/// untrusted input, so a fallback beats a crash on a future server-added type.
ExamItemType examItemTypeFromWire(String wire) => switch (wire) {
  'short_answer' => ExamItemType.shortAnswer,
  _ => ExamItemType.mcq,
};

/// One choice on an [ExamItemType.mcq] item.
class ExamOption {
  const ExamOption({required this.id, required this.text});

  final String id;
  final String text;

  factory ExamOption.fromJson(Map<String, Object?> json) =>
      ExamOption(id: json['id']! as String, text: json['text']! as String);
}

/// A resolved pointer from an item back to the study material it was grounded on. Exam items,
/// like quiz questions, carry exactly one — never revealed until the report, since [ExamItem]
/// itself never carries the answer key either.
class ExamCitation {
  const ExamCitation({
    required this.chunkId,
    required this.materialId,
    this.materialTitle,
    this.pageNumber,
    this.sectionTitle,
  });

  final String chunkId;
  final String materialId;
  final String? materialTitle;

  /// 1-based page (PDF) or slide (slide deck), or null when the material has no paginated
  /// structure. Same convention as `QuizCitation.pageNumber`.
  final int? pageNumber;
  final String? sectionTitle;

  factory ExamCitation.fromJson(Map<String, Object?> json) => ExamCitation(
    chunkId: json['chunk_id']! as String,
    materialId: json['material_id']! as String,
    materialTitle: json['material_title'] as String?,
    pageNumber: json['page_number'] as int?,
    sectionTitle: json['section_title'] as String?,
  );
}

/// One exam item as revealed by `start`: prompt, choices (for `mcq`), and citation. Never
/// carries the answer key — that stays server-side until the submit response's [ExamReport].
class ExamItem {
  const ExamItem({
    required this.id,
    required this.order,
    required this.type,
    required this.prompt,
    required this.options,
    required this.citation,
  });

  final String id;

  /// 1-based position within the exam.
  final int order;
  final ExamItemType type;
  final String prompt;

  /// Choices for [ExamItemType.mcq], in generation order. Null for [ExamItemType.shortAnswer].
  final List<ExamOption>? options;
  final ExamCitation citation;

  factory ExamItem.fromJson(Map<String, Object?> json) {
    final optionsJson = json['options'] as List<Object?>?;
    return ExamItem(
      id: json['id']! as String,
      order: json['order']! as int,
      type: examItemTypeFromWire(json['type']! as String),
      prompt: json['prompt']! as String,
      options: optionsJson
          ?.map((option) => ExamOption.fromJson(option! as Map<String, Object?>))
          .toList(),
      citation: ExamCitation.fromJson(json['citation']! as Map<String, Object?>),
    );
  }
}

/// One citation of a missed item within a weak (or not) topic — what to go re-read, not
/// everything asked. See `exam/report.ts`'s `TopicStudyReference`.
class ExamStudyReference {
  const ExamStudyReference({required this.chunkId, this.pageNumber, this.sectionTitle});

  final String chunkId;
  final int? pageNumber;
  final String? sectionTitle;

  factory ExamStudyReference.fromJson(Map<String, Object?> json) => ExamStudyReference(
    chunkId: json['chunk_id']! as String,
    pageNumber: json['page_number'] as int?,
    sectionTitle: json['section_title'] as String?,
  );
}

/// One material's slice of the report: how the student did on items grounded in it, and where
/// to go study the ones they missed. "Topic" is the material an item was grounded on — see
/// `exam/report.ts`'s doc comment for why that's the right granularity.
class ExamTopicReport {
  const ExamTopicReport({
    required this.materialId,
    required this.materialTitle,
    required this.correct,
    required this.total,
    required this.percentage,
    required this.weak,
    required this.studyReferences,
  });

  final String materialId;
  final String? materialTitle;
  final int correct;
  final int total;

  /// Rounded to the nearest whole percent.
  final int percentage;

  /// True at or below `AI_EXAM_WEAK_TOPIC_THRESHOLD` — this is where "weak-topic study links"
  /// point.
  final bool weak;
  final List<ExamStudyReference> studyReferences;

  factory ExamTopicReport.fromJson(Map<String, Object?> json) => ExamTopicReport(
    materialId: json['material_id']! as String,
    materialTitle: json['material_title'] as String?,
    correct: json['correct']! as int,
    total: json['total']! as int,
    percentage: json['percentage']! as int,
    weak: json['weak']! as bool,
    studyReferences: (json['study_references']! as List<Object?>)
        .map((ref) => ExamStudyReference.fromJson(ref! as Map<String, Object?>))
        .toList(),
  );
}

/// The exam's scoring report, available once submitted: overall score plus a per-topic
/// breakdown with study links for anything weak.
class ExamReport {
  const ExamReport({
    required this.correctCount,
    required this.totalItems,
    required this.percentage,
    required this.topics,
  });

  final int correctCount;
  final int totalItems;

  /// Rounded to the nearest whole percent; 0 for an exam with no items.
  final int percentage;
  final List<ExamTopicReport> topics;

  factory ExamReport.fromJson(Map<String, Object?> json) => ExamReport(
    correctCount: json['correct_count']! as int,
    totalItems: json['total_items']! as int,
    percentage: json['percentage']! as int,
    topics: (json['topics']! as List<Object?>)
        .map((topic) => ExamTopicReport.fromJson(topic! as Map<String, Object?>))
        .toList(),
  );
}
