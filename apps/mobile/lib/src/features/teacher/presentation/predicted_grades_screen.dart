import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../design/layout/bottom_inset_padding.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/predicted_grades_providers.dart';
import '../domain/predicted_grades.dart';
import 'widgets/mark_sheet_common.dart';

/// The subject teacher's predicted grades (000254) for the class's section and subject: one
/// grade per student for the whole year or a term, chosen from the subject's grading scale (or
/// typed, when the subject has no scale), saved together.
///
/// Pushed from [TeacherClassDetailScreen]. The class resolves to its grade section and subject
/// first; a class without a section has no predicted grades. When the school has not switched
/// predicted grades on for the grade, or the year is closed, the list is read-only.
class PredictedGradesScreen extends ConsumerWidget {
  const PredictedGradesScreen({
    required this.classId,
    required this.classCode,
    super.key,
  });

  final String classId;
  final String classCode;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final target = ref.watch(classGradingTargetProvider(classId));
    return target.when(
      loading: () => _Shell(
        classCode: classCode,
        body: const Center(child: CircularProgressIndicator()),
      ),
      error: (_, _) => _Shell(
        classCode: classCode,
        body: MarksMessage(
          icon: Icons.error_outline,
          message: 'teacher.predicted.error'.tr(),
          onRetry: () => ref.invalidate(classGradingTargetProvider(classId)),
        ),
      ),
      data: (target) => target == null
          ? _Shell(
              classCode: classCode,
              body: MarksMessage(
                icon: Icons.info_outline,
                message: 'teacher.predicted.noSection'.tr(),
              ),
            )
          : PredictedGradesEditor(
              sectionId: target.sectionId,
              subjectId: target.subjectId,
              classCode: classCode,
            ),
    );
  }
}

class _Shell extends StatelessWidget {
  const _Shell({required this.classCode, required this.body});

  final String classCode;
  final Widget body;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: _Title(subtitle: classCode)),
      body: body,
    );
  }
}

class _Title extends StatelessWidget {
  const _Title({required this.subtitle});

  final String subtitle;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('teacher.predicted.title'.tr()),
        if (subtitle.isNotEmpty)
          Text(subtitle, style: Theme.of(context).textTheme.bodySmall),
      ],
    );
  }
}

/// The editor for one section and subject, by period.
class PredictedGradesEditor extends ConsumerStatefulWidget {
  const PredictedGradesEditor({
    required this.sectionId,
    required this.subjectId,
    required this.classCode,
    super.key,
  });

  final String sectionId;
  final String subjectId;
  final String classCode;

  @override
  ConsumerState<PredictedGradesEditor> createState() =>
      _PredictedGradesEditorState();
}

class _PredictedGradesEditorState extends ConsumerState<PredictedGradesEditor> {
  /// Null: the whole year.
  String? _termId;

  /// Unsaved choices, by student id (null or blank removes the prediction).
  final Map<String, String?> _edits = {};
  final Map<String, TextEditingController> _controllers = {};
  bool _saving = false;

  PredictedGradesKey get _key => (
    sectionId: widget.sectionId,
    subjectId: widget.subjectId,
    termId: _termId,
  );

  @override
  void dispose() {
    for (final controller in _controllers.values) {
      controller.dispose();
    }
    super.dispose();
  }

  void _choosePeriod(String? termId) {
    if (termId == _termId) return;
    setState(() {
      _termId = termId;
      _edits.clear();
      for (final controller in _controllers.values) {
        controller.dispose();
      }
      _controllers.clear();
    });
  }

  Map<String, String?> _changes(SectionPredictedGrades data) => {
    for (final student in data.students)
      if (_edits.containsKey(student.studentId) &&
          (_edits[student.studentId]?.trim() ?? '') !=
              (student.gradeLabel ?? ''))
        student.studentId: _edits[student.studentId],
  };

  Future<void> _save(SectionPredictedGrades data) async {
    final changes = _changes(data);
    if (changes.isEmpty) return;
    setState(() => _saving = true);
    try {
      await ref
          .read(predictedGradesClientProvider)
          .save(
            widget.sectionId,
            widget.subjectId,
            termId: _termId,
            grades: changes,
          );
      if (!mounted) return;
      _edits.clear();
      ref.invalidate(predictedGradesProvider(_key));
      _snack('teacher.predicted.saved'.tr());
    } catch (error) {
      _snack(_errorMessage(error));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  String _errorMessage(Object error) {
    return switch (markErrorCode(error)) {
      'PREDICTED_GRADES_DISABLED' => 'teacher.predicted.disabled'.tr(),
      'ACADEMIC_CONFIG_LOCKED' => 'teacher.predicted.readOnly'.tr(),
      'VALIDATION_FAILED' => 'teacher.predicted.invalid'.tr(),
      _ => markErrorMessage(error),
    };
  }

  void _snack(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..clearSnackBars()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  Widget build(BuildContext context) {
    final async = ref.watch(predictedGradesProvider(_key));
    final data = async.value;
    final dirty = data != null && _changes(data).isNotEmpty;

    return Scaffold(
      appBar: AppBar(
        title: _Title(
          subtitle: data == null
              ? widget.classCode
              : [
                  data.subjectName,
                  data.sectionLabel,
                ].where((part) => part.isNotEmpty).join(' · '),
        ),
        actions: [
          if (data?.editable ?? false)
            TextButton(
              onPressed: dirty && !_saving ? () => _save(data) : null,
              child: _saving
                  ? const SizedBox.square(
                      dimension: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : Text('teacher.predicted.save'.tr()),
            ),
        ],
      ),
      body: async.when(
        skipLoadingOnReload: true,
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (_, _) => MarksMessage(
          icon: Icons.error_outline,
          message: 'teacher.predicted.error'.tr(),
          onRetry: () => ref.invalidate(predictedGradesProvider(_key)),
        ),
        data: _body,
      ),
    );
  }

  Widget _body(SectionPredictedGrades data) {
    final theme = Theme.of(context);
    final notice = !data.enabled
        ? 'teacher.predicted.disabled'.tr()
        : !data.editable
        ? 'teacher.predicted.readOnly'.tr()
        : null;
    return ListView(
      padding: const EdgeInsets.all(
        AppSpacing.space16,
      ).withBottomInset(context),
      children: [
        Text(
          'teacher.predicted.help'.tr(),
          style: theme.textTheme.bodyMedium?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: AppSpacing.space12),
        DropdownButtonFormField<String?>(
          initialValue: _termId,
          isExpanded: true,
          decoration: InputDecoration(
            labelText: 'teacher.predicted.period'.tr(),
            border: const OutlineInputBorder(),
          ),
          items: [
            DropdownMenuItem<String?>(
              child: Text('teacher.predicted.wholeYear'.tr()),
            ),
            for (final term in data.terms)
              DropdownMenuItem<String?>(
                value: term.termId,
                child: Text(term.name),
              ),
          ],
          onChanged: _choosePeriod,
        ),
        if (notice != null) ...[
          const SizedBox(height: AppSpacing.space12),
          Text(notice, style: theme.textTheme.bodyMedium),
        ],
        const SizedBox(height: AppSpacing.space16),
        if (data.students.isEmpty) Text('teacher.predicted.noStudents'.tr()),
        for (final student in data.students)
          Padding(
            padding: const EdgeInsets.only(bottom: AppSpacing.space12),
            child: data.labels.isEmpty
                ? _textField(data, student)
                : _dropdown(data, student),
          ),
      ],
    );
  }

  String? _current(({String studentId, String name, String? gradeLabel}) s) =>
      _edits.containsKey(s.studentId) ? _edits[s.studentId] : s.gradeLabel;

  Widget _dropdown(
    SectionPredictedGrades data,
    ({String studentId, String name, String? gradeLabel}) student,
  ) {
    final current = _current(student);
    // A saved label no longer on the scale stays visible (and replaceable) rather than crashing
    // the dropdown.
    final labels = [
      ...data.labels,
      if (current != null &&
          current.isNotEmpty &&
          !data.labels.contains(current))
        current,
    ];
    return DropdownButtonFormField<String?>(
      key: ValueKey('predicted-${student.studentId}-${_termId ?? 'year'}'),
      initialValue: current == null || current.isEmpty ? null : current,
      isExpanded: true,
      decoration: InputDecoration(
        labelText: student.name,
        border: const OutlineInputBorder(),
      ),
      items: [
        DropdownMenuItem<String?>(child: Text('teacher.predicted.none'.tr())),
        for (final label in labels)
          DropdownMenuItem<String?>(value: label, child: Text(label)),
      ],
      onChanged: data.editable
          ? (value) => setState(() => _edits[student.studentId] = value)
          : null,
    );
  }

  Widget _textField(
    SectionPredictedGrades data,
    ({String studentId, String name, String? gradeLabel}) student,
  ) {
    final controller = _controllers.putIfAbsent(
      student.studentId,
      () => TextEditingController(text: student.gradeLabel ?? ''),
    );
    return TextField(
      controller: controller,
      enabled: data.editable,
      maxLength: predictedGradeLabelMaxLength,
      decoration: InputDecoration(
        labelText: student.name,
        counterText: '',
        border: const OutlineInputBorder(),
      ),
      onChanged: (value) => setState(() => _edits[student.studentId] = value),
    );
  }
}
