/// A member of staff's own school-defined record (`GET /api/me/staff-record`; OpenAPI tag
/// "Staff and class records", docs/modules/student-records.md "Staff and class records").
///
/// Hand-written, as `features/student/domain/academic_results.dart` is: the generated
/// `SubjectRecords` cannot carry this response. An answer is a string, number, yes/no or list of
/// choices (`RecordValue`), which the generator turns into an empty wrapper class, and the nullable
/// `document` becomes a required object that fails to parse when the API sends null. JSON shapes
/// follow the API's `records/schemas.ts` (`SubjectRecords`, `RecordEntry`,
/// `RecordFieldDefinition`, `RecordDocument`).
///
/// The API sends a staff member only their fields that are not sensitive, so nothing here is ever
/// masked: there is no reveal on this screen.
library;

/// One choice of a choice field, as the school named it.
class RecordChoice {
  const RecordChoice({
    required this.value,
    required this.labelEn,
    required this.labelAr,
  });

  factory RecordChoice.fromJson(Map<String, Object?> json) => RecordChoice(
    value: json['value']! as String,
    labelEn: json['label_en']! as String,
    labelAr: json['label_ar']! as String,
  );

  final String value;
  final String labelEn;
  final String labelAr;
}

/// The file behind a document field.
class RecordFile {
  const RecordFile({
    required this.status,
    required this.fileName,
    required this.expiresOn,
  });

  factory RecordFile.fromJson(Map<String, Object?> json) => RecordFile(
    status: json['status']! as String,
    fileName: json['file_name'] as String?,
    expiresOn: _day(json['expires_on']),
  );

  /// `missing`, `uploaded` or `verified`.
  final String status;
  final String? fileName;

  /// The expiry day as `YYYY-MM-DD`, if the document has one.
  final String? expiresOn;

  bool get onFile => status != 'missing';
  bool get verified => status == 'verified';
}

/// One field of the form and the staff member's answer to it.
class OwnRecordEntry {
  const OwnRecordEntry({
    required this.fieldId,
    required this.fieldType,
    required this.labelEn,
    required this.labelAr,
    required this.options,
    required this.value,
    required this.missing,
    required this.file,
  });

  factory OwnRecordEntry.fromJson(Map<String, Object?> json) {
    final field = Map<String, Object?>.from(json['field']! as Map);
    final document = json['document'];
    return OwnRecordEntry(
      fieldId: field['id']! as String,
      fieldType: field['field_type']! as String,
      labelEn: field['label_en']! as String,
      labelAr: field['label_ar']! as String,
      options: [
        for (final option
            in (field['options'] as List<Object?>?) ?? const <Object?>[])
          RecordChoice.fromJson(Map<String, Object?>.from(option! as Map)),
      ],
      value: json['value'],
      missing: json['missing'] == true,
      file: document is Map
          ? RecordFile.fromJson(Map<String, Object?>.from(document))
          : null,
    );
  }

  final String fieldId;
  final String fieldType;
  final String labelEn;
  final String labelAr;
  final List<RecordChoice> options;

  /// The raw answer: a string, number, bool or list of choice values; null when unanswered.
  final Object? value;

  /// Required, and not answered (or no file).
  final bool missing;
  final RecordFile? file;

  bool get isDocument => fieldType == 'document';

  String label(String languageCode) => languageCode == 'ar' ? labelAr : labelEn;

  /// The answer as text, or null when there is none. A choice reads as the school's label for it,
  /// and a date as its calendar day: the API may send a midnight-UTC timestamp, whose first ten
  /// characters are the day.
  String? displayValue(
    String languageCode, {
    required String yes,
    required String no,
  }) {
    final raw = value;
    if (raw == null) return null;
    String choiceLabel(Object? choice) {
      for (final option in options) {
        if (option.value == choice) {
          return languageCode == 'ar' ? option.labelAr : option.labelEn;
        }
      }
      return '$choice';
    }

    return switch (fieldType) {
      'yes_no' => raw == true ? yes : no,
      'date' => _day(raw),
      'single_choice' => choiceLabel(raw),
      'multi_choice' when raw is List => raw.map(choiceLabel).join(', '),
      _ => raw is num && raw == raw.roundToDouble() ? '${raw.toInt()}' : '$raw',
    };
  }
}

/// The staff member's own record: the published form's non-sensitive fields, in order.
class OwnStaffRecord {
  const OwnStaffRecord({
    required this.templateVersion,
    required this.entries,
    required this.missingRequired,
  });

  factory OwnStaffRecord.fromJson(Map<String, Object?> json) => OwnStaffRecord(
    templateVersion: (json['template_version'] as num?)?.toInt() ?? 0,
    missingRequired: (json['missing_required'] as num?)?.toInt() ?? 0,
    entries: [
      for (final entry
          in (json['entries'] as List<Object?>?) ?? const <Object?>[])
        OwnRecordEntry.fromJson(Map<String, Object?>.from(entry! as Map)),
    ],
  );

  /// 0 until the school publishes its staff form.
  final int templateVersion;
  final List<OwnRecordEntry> entries;
  final int missingRequired;

  bool get published => templateVersion > 0;
}

String? _day(Object? value) {
  if (value is! String) return null;
  return value.length < 10 ? value : value.substring(0, 10);
}
