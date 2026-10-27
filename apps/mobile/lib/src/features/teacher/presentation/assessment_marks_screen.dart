import 'package:dio/dio.dart';
import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../design/tokens/app_spacing_tokens.dart';
import '../../student/presentation/widgets/status_pill.dart';
import '../application/mark_entry_editor.dart';
import '../application/mark_sheet_providers.dart';
import '../domain/mark_sheet.dart';
import 'widgets/mark_sheet_common.dart';

/// Mark entry for one assessment: a row per student with a score field (validated against the
/// assessment's maximum as the teacher types), a status menu (absent / excused / not applicable /
/// clear), and — when the subject has a retake policy — a second-attempt row.
///
/// Edits are held in a [MarkEntryEditor] and written together with Save; a value outside
/// `0..max` is flagged inline and keeps Save disabled, so it never reaches the API. When the
/// period is submitted or approved, or the year is not active, every row is read-only.
class AssessmentMarksScreen extends ConsumerStatefulWidget {
  const AssessmentMarksScreen({
    required this.sheetKey,
    required this.assessmentId,
    super.key,
  });

  final MarkSheetKey sheetKey;
  final String assessmentId;

  @override
  ConsumerState<AssessmentMarksScreen> createState() =>
      _AssessmentMarksScreenState();
}

class _AssessmentMarksScreenState extends ConsumerState<AssessmentMarksScreen> {
  MarkEntryEditor? _editor;
  final Map<MarkCellKey, TextEditingController> _controllers = {};
  bool _saving = false;

  @override
  void dispose() {
    _editor?.dispose();
    for (final controller in _controllers.values) {
      controller.dispose();
    }
    super.dispose();
  }

  MarkEntryEditor _editorFor(MarkSheet sheet, MarkSheetAssessment assessment) {
    final existing = _editor;
    if (existing != null) return existing;
    final editor = MarkEntryEditor(assessment: assessment, sheet: sheet)
      ..addListener(_syncControllers);
    return _editor = editor;
  }

  /// Push editor-side text changes (a reseed, a status change, a discard) into the fields.
  void _syncControllers() {
    final editor = _editor;
    if (editor == null) return;
    _controllers.forEach((key, controller) {
      final text = editor.textFor(key);
      if (controller.text != text) {
        controller.value = TextEditingValue(
          text: text,
          selection: TextSelection.collapsed(offset: text.length),
        );
      }
    });
  }

  TextEditingController _controllerFor(
    MarkCellKey key,
    MarkEntryEditor editor,
  ) => _controllers.putIfAbsent(
    key,
    () => TextEditingController(text: editor.textFor(key)),
  );

  @override
  Widget build(BuildContext context) {
    ref.listen(markSheetProvider(widget.sheetKey), (_, next) {
      final sheet = next.value;
      if (sheet != null) _editor?.seed(sheet);
    });
    final sheetAsync = ref.watch(markSheetProvider(widget.sheetKey));
    final sheet = sheetAsync.value;
    final assessment = sheet?.assessmentById(widget.assessmentId);

    if (sheet == null || assessment == null) {
      return Scaffold(
        appBar: AppBar(),
        body: sheetAsync.isLoading
            ? const Center(child: CircularProgressIndicator())
            : MarksMessage(
                icon: Icons.error_outline,
                message: 'teacher.marks.sheet.error'.tr(),
                onRetry: () =>
                    ref.invalidate(markSheetProvider(widget.sheetKey)),
              ),
      );
    }

    final editor = _editorFor(sheet, assessment);
    return ListenableBuilder(
      listenable: editor,
      builder: (context, _) => PopScope(
        canPop: !editor.hasChanges,
        onPopInvokedWithResult: (didPop, _) async {
          if (didPop) return;
          final discard = await _confirmDiscard();
          if (discard && context.mounted) {
            editor.discardChanges();
            Navigator.of(context).pop();
          }
        },
        child: Scaffold(
          appBar: AppBar(
            title: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(assessment.name),
                Text(
                  'teacher.marks.entry.outOf'.tr(
                    namedArgs: {'max': formatMarkNumber(assessment.maxMarks)},
                  ),
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],
            ),
          ),
          body: Column(
            children: [
              Expanded(child: _buildRows(sheet, editor.assessment, editor)),
              _SaveBar(
                editor: editor,
                editable: sheet.isPeriodEditable(assessment.termId),
                saving: _saving,
                onSave: _save,
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildRows(
    MarkSheet sheet,
    MarkSheetAssessment assessment,
    MarkEntryEditor editor,
  ) {
    final lockMessage = _lockMessage(sheet, assessment);
    return ListView(
      padding: const EdgeInsets.all(AppSpacing.space16),
      children: [
        if (lockMessage != null)
          Padding(
            padding: const EdgeInsets.only(bottom: AppSpacing.space12),
            child: Row(
              children: [
                const Icon(Icons.lock_outline, size: 18),
                const SizedBox(width: AppSpacing.space8),
                Expanded(child: Text(lockMessage)),
              ],
            ),
          ),
        for (final student in sheet.students)
          if (student.isExempt)
            Card(
              margin: const EdgeInsets.only(bottom: AppSpacing.space8),
              child: ListTile(
                enabled: false,
                title: Text(student.displayName),
                subtitle: Text('teacher.marks.entry.exempt'.tr()),
                trailing: StatusPill(
                  label: 'teacher.marks.preview.exempt'.tr(),
                  tone: StatusPillTone.neutral,
                ),
              ),
            )
          else
            Card(
              margin: const EdgeInsets.only(bottom: AppSpacing.space8),
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: AppSpacing.space12,
                  vertical: AppSpacing.space8,
                ),
                child: Column(
                  children: [
                    for (final attempt in const [1, 2])
                      if (editor.hasCell((
                        studentId: student.studentId,
                        attempt: attempt,
                      )))
                        _MarkRow(
                          cellKey: (
                            studentId: student.studentId,
                            attempt: attempt,
                          ),
                          student: student,
                          assessment: assessment,
                          editor: editor,
                          controller: _controllerFor((
                            studentId: student.studentId,
                            attempt: attempt,
                          ), editor),
                          editable: sheet.isCellEditable(assessment, student),
                          canAddRetake:
                              attempt == 1 &&
                              sheet.config.allowsRetake &&
                              editor.originalFor((
                                    studentId: student.studentId,
                                    attempt: 1,
                                  )) !=
                                  null &&
                              !editor.hasCell((
                                studentId: student.studentId,
                                attempt: 2,
                              )),
                          isMissing:
                              attempt == 1 &&
                              (student.preview?.missingAssessmentIds.contains(
                                    assessment.id,
                                  ) ??
                                  false),
                        ),
                  ],
                ),
              ),
            ),
      ],
    );
  }

  String? _lockMessage(MarkSheet sheet, MarkSheetAssessment assessment) {
    if (!sheet.canEditMarks) return 'teacher.marks.sheet.yearNotActive'.tr();
    final period = sheet.periodFor(assessment.termId);
    if (period == null || period.status.isOpen) {
      return assessment.isActive
          ? null
          : 'teacher.marks.sheet.proposedHint'.tr();
    }
    return switch (period.status) {
      MarkSheetPeriodStatus.submitted =>
        'teacher.marks.sheet.lockedSubmitted'.tr(),
      MarkSheetPeriodStatus.approved =>
        'teacher.marks.sheet.lockedApproved'.tr(),
      _ => 'teacher.marks.sheet.lockedUnknown'.tr(),
    };
  }

  Future<bool> _confirmDiscard() async {
    final result = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text('teacher.marks.entry.discardTitle'.tr()),
        content: Text('teacher.marks.entry.discardBody'.tr()),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: Text('teacher.marks.entry.keepEditing'.tr()),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: Text('teacher.marks.entry.discard'.tr()),
          ),
        ],
      ),
    );
    return result ?? false;
  }

  void _snack(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..clearSnackBars()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  Future<void> _save() async {
    final editor = _editor;
    if (editor == null || editor.hasErrors || _saving) return;
    final entries = editor.pendingEntries();
    if (entries.isEmpty) return;

    setState(() => _saving = true);
    final notifier = ref.read(markSheetProvider(widget.sheetKey).notifier);
    Object? failure;
    try {
      final sheet = await notifier.save(entries);
      editor.seed(sheet);
    } on DioException catch (error) {
      failure = error;
    }
    if (!mounted) return;
    // Stop the spinner before any follow-up dialog, which can stay open indefinitely.
    setState(() => _saving = false);

    if (failure == null) {
      _snack('teacher.marks.entry.saved'.tr());
      return;
    }
    final code = markErrorCode(failure);
    if (code == 'GRADE_CONCURRENT_EDIT') {
      await _showConflict(editor);
    } else {
      _snack(markErrorMessage(failure));
      if (code == 'MARKS_LOCKED' || code == 'ACADEMIC_YEAR_NOT_ACTIVE') {
        await _reloadQuietly();
      }
    }
  }

  /// Someone else changed one of these marks since it was loaded: the whole batch was refused.
  /// The honest resolution is to reload and let the teacher re-enter on top of the latest marks.
  Future<void> _showConflict(MarkEntryEditor editor) async {
    await showDialog<void>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        content: Text('teacher.marks.errors.conflict'.tr()),
        actions: [
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: Text('teacher.marks.errors.reload'.tr()),
          ),
        ],
      ),
    );
    editor.discardChanges();
    await _reloadQuietly();
  }

  Future<void> _reloadQuietly() async {
    try {
      await ref.read(markSheetProvider(widget.sheetKey).notifier).reload();
    } catch (error) {
      _snack(markErrorMessage(error));
    }
  }
}

enum _MenuAction { graded, absent, excused, notApplicable, clear, addRetake }

class _MarkRow extends StatelessWidget {
  const _MarkRow({
    required this.cellKey,
    required this.student,
    required this.assessment,
    required this.editor,
    required this.controller,
    required this.editable,
    required this.canAddRetake,
    required this.isMissing,
  });

  final MarkCellKey cellKey;
  final MarkSheetStudent student;
  final MarkSheetAssessment assessment;
  final MarkEntryEditor editor;
  final TextEditingController controller;
  final bool editable;
  final bool canAddRetake;

  /// The engine reports this mandatory mark as missing (as of the last load).
  final bool isMissing;

  bool get _isRetake => cellKey.attempt == 2;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final status = editor.statusFor(cellKey);
    final error = editor.errorFor(cellKey);
    final dirty = editor.isDirty(cellKey);
    final max = formatMarkNumber(assessment.maxMarks);
    // A recorded mark the teacher emptied (or chose "Clear") — saving deletes it.
    final willClear =
        dirty &&
        editor.originalFor(cellKey) != null &&
        (status == null ||
            (status == MarkStatus.graded &&
                editor.textFor(cellKey).trim().isEmpty));

    final note = willClear
        ? Text(
            'teacher.marks.entry.cleared'.tr(),
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.error,
            ),
          )
        : isMissing && !dirty
        ? Text(
            'teacher.marks.entry.missing'.tr(),
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.error,
              fontWeight: FontWeight.w600,
            ),
          )
        : null;

    return Padding(
      padding: EdgeInsetsDirectional.only(
        start: _isRetake ? AppSpacing.space16 : 0,
        top: AppSpacing.space4,
        bottom: AppSpacing.space4,
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Padding(
              padding: const EdgeInsets.only(top: AppSpacing.space8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      if (dirty)
                        Padding(
                          padding: const EdgeInsetsDirectional.only(
                            end: AppSpacing.space4,
                          ),
                          child: Icon(
                            Icons.circle,
                            size: 8,
                            color: theme.colorScheme.primary,
                          ),
                        ),
                      Flexible(
                        child: Text(
                          _isRetake
                              ? 'teacher.marks.entry.retake'.tr()
                              : student.displayName,
                          style: _isRetake
                              ? theme.textTheme.bodyMedium
                              : theme.textTheme.titleSmall,
                        ),
                      ),
                    ],
                  ),
                  if (!_isRetake && student.admissionNumber.isNotEmpty)
                    Text(
                      student.admissionNumber,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ?note,
                ],
              ),
            ),
          ),
          const SizedBox(width: AppSpacing.space8),
          SizedBox(
            width: 120,
            child: status == null || status == MarkStatus.graded
                ? TextField(
                    key: ValueKey(
                      'mark-field-${cellKey.studentId}-${cellKey.attempt}',
                    ),
                    controller: controller,
                    enabled: editable,
                    keyboardType: const TextInputType.numberWithOptions(
                      decimal: true,
                    ),
                    textInputAction: TextInputAction.next,
                    onChanged: (text) => editor.setText(cellKey, text),
                    decoration: InputDecoration(
                      isDense: true,
                      hintText: '—',
                      suffixText: '/ $max',
                      errorMaxLines: 2,
                      errorText: switch (error) {
                        MarkCellError.outOfRange =>
                          'teacher.marks.entry.errorRange'.tr(
                            namedArgs: {'max': max},
                          ),
                        MarkCellError.notANumber =>
                          'teacher.marks.entry.errorNumber'.tr(),
                        null => null,
                      },
                    ),
                  )
                : Padding(
                    padding: const EdgeInsets.only(top: AppSpacing.space8),
                    child: Align(
                      alignment: AlignmentDirectional.centerEnd,
                      child: StatusPill(
                        label: _statusLabel(status),
                        tone: StatusPillTone.neutral,
                      ),
                    ),
                  ),
          ),
          if (editable)
            PopupMenuButton<_MenuAction>(
              tooltip: 'teacher.marks.entry.statusMenu'.tr(),
              icon: const Icon(Icons.more_vert),
              onSelected: (action) => switch (action) {
                _MenuAction.graded => editor.setStatus(
                  cellKey,
                  MarkStatus.graded,
                ),
                _MenuAction.absent => editor.setStatus(
                  cellKey,
                  MarkStatus.absent,
                ),
                _MenuAction.excused => editor.setStatus(
                  cellKey,
                  MarkStatus.excused,
                ),
                _MenuAction.notApplicable => editor.setStatus(
                  cellKey,
                  MarkStatus.notApplicable,
                ),
                _MenuAction.clear => editor.setStatus(cellKey, null),
                _MenuAction.addRetake => editor.addRetake(cellKey.studentId),
              },
              itemBuilder: (_) => [
                for (final (action, status) in const [
                  (_MenuAction.graded, MarkStatus.graded),
                  (_MenuAction.absent, MarkStatus.absent),
                  (_MenuAction.excused, MarkStatus.excused),
                  (_MenuAction.notApplicable, MarkStatus.notApplicable),
                ])
                  PopupMenuItem(
                    value: action,
                    child: Text(_statusLabel(status)),
                  ),
                PopupMenuItem(
                  value: _MenuAction.clear,
                  child: Text('teacher.marks.entry.clear'.tr()),
                ),
                if (canAddRetake)
                  PopupMenuItem(
                    value: _MenuAction.addRetake,
                    child: Text('teacher.marks.entry.addRetake'.tr()),
                  ),
              ],
            )
          else
            const SizedBox(width: AppSpacing.space8),
        ],
      ),
    );
  }

  static String _statusLabel(MarkStatus status) => switch (status) {
    MarkStatus.graded => 'teacher.marks.entry.markStatus.graded'.tr(),
    MarkStatus.absent => 'teacher.marks.entry.markStatus.absent'.tr(),
    MarkStatus.excused => 'teacher.marks.entry.markStatus.excused'.tr(),
    MarkStatus.notApplicable =>
      'teacher.marks.entry.markStatus.notApplicable'.tr(),
  };
}

class _SaveBar extends StatelessWidget {
  const _SaveBar({
    required this.editor,
    required this.editable,
    required this.saving,
    required this.onSave,
  });

  final MarkEntryEditor editor;
  final bool editable;
  final bool saving;
  final VoidCallback onSave;

  @override
  Widget build(BuildContext context) {
    if (!editable) return const SizedBox.shrink();
    final theme = Theme.of(context);
    final hasErrors = editor.hasErrors;
    final changes = editor.dirtyCount;

    return Material(
      elevation: 3,
      color: theme.colorScheme.surface,
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: AppSpacing.space16,
            vertical: AppSpacing.space12,
          ),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  hasErrors
                      ? 'teacher.marks.entry.fixErrors'.tr()
                      : changes > 0
                      ? 'teacher.marks.entry.unsaved'.tr(
                          namedArgs: {'count': '$changes'},
                        )
                      : 'teacher.marks.entry.allSaved'.tr(),
                  style: theme.textTheme.bodyMedium?.copyWith(
                    color: hasErrors ? theme.colorScheme.error : null,
                  ),
                ),
              ),
              const SizedBox(width: AppSpacing.space12),
              FilledButton(
                key: const ValueKey('mark-save'),
                onPressed: !saving && changes > 0 && !hasErrors ? onSave : null,
                child: saving
                    ? const SizedBox.square(
                        dimension: 16,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : Text('teacher.marks.entry.save'.tr()),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
