/// IB Diploma core grades of a section (`/api/grading/sections/{sectionId}/diploma-core`, OpenAPI
/// tag `Results`, 000262): Theory of Knowledge and Extended Essay grades (A–E) and CAS, final or
/// predicted, entered by the section's teachers (TOK and EE supervisors). Hand-written like
/// `predicted_grades.dart`; JSON follows the API's `SectionDiplomaCore` schema.
library;

/// TOK and Extended Essay grades, best first.
const diplomaCoreGrades = ['A', 'B', 'C', 'D', 'E'];

/// Which core grades are being entered: the final ones (used when results are finalized) or the
/// predicted ones (giving the predicted total).
enum DiplomaCoreKind {
  finalGrades('final'),
  predicted('predicted');

  const DiplomaCoreKind(this.wire);

  final String wire;
}

/// One student's TOK, EE and CAS; null for what is not recorded.
class DiplomaCoreValues {
  const DiplomaCoreValues({this.tok, this.ee, this.casComplete});

  /// Null for anything that isn't an object. A grade this build does not know reads as none.
  static DiplomaCoreValues? fromJson(Object? json) {
    if (json is! Map) return null;
    return DiplomaCoreValues(
      tok: _grade(json['tok_grade']),
      ee: _grade(json['ee_grade']),
      casComplete: json['cas_complete'] as bool?,
    );
  }

  final String? tok;
  final String? ee;
  final bool? casComplete;

  bool get isEmpty => tok == null && ee == null && casComplete == null;

  DiplomaCoreValues copyWith({
    String? Function()? tok,
    String? Function()? ee,
    bool? Function()? casComplete,
  }) => DiplomaCoreValues(
    tok: tok == null ? this.tok : tok(),
    ee: ee == null ? this.ee : ee(),
    casComplete: casComplete == null ? this.casComplete : casComplete(),
  );

  Map<String, Object?> toJson(String studentId) => {
    'student_id': studentId,
    'tok_grade': tok,
    'ee_grade': ee,
    'cas_complete': casComplete,
  };

  @override
  bool operator ==(Object other) =>
      other is DiplomaCoreValues &&
      other.tok == tok &&
      other.ee == ee &&
      other.casComplete == casComplete;

  @override
  int get hashCode => Object.hash(tok, ee, casComplete);
}

class DiplomaCoreStudent {
  const DiplomaCoreStudent({
    required this.studentId,
    required this.name,
    required this.finalGrades,
    required this.predicted,
  });

  factory DiplomaCoreStudent.fromJson(Map<String, Object?> json) =>
      DiplomaCoreStudent(
        studentId: json['student_id'] as String? ?? '',
        name: [
          json['first_name'] as String? ?? '',
          json['last_name'] as String? ?? '',
        ].where((part) => part.isNotEmpty).join(' '),
        finalGrades:
            DiplomaCoreValues.fromJson(json['final']) ??
            const DiplomaCoreValues(),
        predicted:
            DiplomaCoreValues.fromJson(json['predicted']) ??
            const DiplomaCoreValues(),
      );

  final String studentId;
  final String name;
  final DiplomaCoreValues finalGrades;
  final DiplomaCoreValues predicted;

  DiplomaCoreValues of(DiplomaCoreKind kind) =>
      kind == DiplomaCoreKind.finalGrades ? finalGrades : predicted;
}

class SectionDiplomaCore {
  const SectionDiplomaCore({
    required this.sectionLabel,
    required this.enabled,
    required this.predictedEnabled,
    required this.editable,
    required this.students,
  });

  factory SectionDiplomaCore.fromJson(Map<String, Object?> json) =>
      SectionDiplomaCore(
        sectionLabel: [
          json['grade_level_name'] as String? ?? '',
          json['section_name'] as String? ?? '',
        ].where((part) => part.isNotEmpty).join(' '),
        enabled: json['enabled'] == true,
        predictedEnabled: json['predicted_enabled'] == true,
        editable: json['editable'] == true,
        students: [
          for (final row in (json['students'] as List<Object?>?) ?? const [])
            if (row is Map)
              DiplomaCoreStudent.fromJson(Map<String, Object?>.from(row)),
        ],
      );

  final String sectionLabel;

  /// The grade's result is the IB Diploma total this year.
  final bool enabled;

  /// The grade records predicted grades, so predicted core grades too.
  final bool predictedEnabled;

  /// Enabled and the year is still open.
  final bool editable;
  final List<DiplomaCoreStudent> students;
}

String? _grade(Object? value) =>
    value is String && diplomaCoreGrades.contains(value) ? value : null;
