import 'package:dio/dio.dart';
import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/api_exception.dart';
import '../../../design/layout/bottom_inset_padding.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/report_comments_providers.dart';
import '../domain/report_comments.dart';
import 'widgets/mark_sheet_common.dart';

/// The subject teacher's report card comments for one section and period: one box per student,
/// saved together. Comments are frozen on the report card when the period is finalized, so once
/// it is (or while the year is not yet published) the boxes are read-only.
class ReportCommentsScreen extends ConsumerStatefulWidget {
  const ReportCommentsScreen({
    required this.sectionId,
    required this.subjectId,
    required this.termId,
    required this.subjectName,
    required this.periodName,
    super.key,
  });

  final String sectionId;
  final String subjectId;

  /// Null for the annual report.
  final String? termId;
  final String subjectName;
  final String periodName;

  @override
  ConsumerState<ReportCommentsScreen> createState() =>
      _ReportCommentsScreenState();
}

class _ReportCommentsScreenState extends ConsumerState<ReportCommentsScreen> {
  static const _maxLength = 1000;

  final Map<String, TextEditingController> _controllers = {};
  Map<String, String> _saved = const {};
  bool _saving = false;

  ReportCommentsKey get _key => (
    sectionId: widget.sectionId,
    subjectId: widget.subjectId,
    termId: widget.termId,
  );

  @override
  void dispose() {
    for (final controller in _controllers.values) {
      controller.dispose();
    }
    super.dispose();
  }

  void _sync(SubjectReportComments data) {
    _saved = {
      for (final student in data.students) student.studentId: student.comment,
    };
    for (final student in data.students) {
      final controller = _controllers.putIfAbsent(
        student.studentId,
        () => TextEditingController()..addListener(() => setState(() {})),
      );
      if (controller.text != student.comment) controller.text = student.comment;
    }
  }

  Map<String, String> get _changes => {
    for (final entry in _controllers.entries)
      if (entry.value.text != (_saved[entry.key] ?? ''))
        entry.key: entry.value.text,
  };

  Future<void> _save() async {
    final changes = _changes;
    if (changes.isEmpty) return;
    setState(() => _saving = true);
    try {
      final data = await ref
          .read(reportCommentsClientProvider)
          .save(
            widget.sectionId,
            widget.subjectId,
            termId: widget.termId,
            comments: changes,
          );
      if (!mounted) return;
      setState(() => _sync(data));
      _snack('teacher.marks.reportComments.saved'.tr());
    } catch (error) {
      _snack(_errorMessage(error));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  String _errorMessage(Object error) {
    final code = error is DioException ? error.apiError?.code : null;
    if (code == 'RESULTS_ALREADY_FINALIZED') {
      return 'teacher.marks.reportComments.finalized'.tr();
    }
    return markErrorMessage(error);
  }

  void _snack(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..clearSnackBars()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  Widget build(BuildContext context) {
    final async = ref.watch(reportCommentsProvider(_key));
    final data = async.value;
    final dirty = _changes.isNotEmpty;

    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('teacher.marks.reportComments.title'.tr()),
            Text(
              '${widget.subjectName} · ${widget.periodName}',
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
        ),
        actions: [
          if (data?.canComment ?? false)
            TextButton(
              onPressed: dirty && !_saving ? _save : null,
              child: _saving
                  ? const SizedBox.square(
                      dimension: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : Text('teacher.marks.reportComments.save'.tr()),
            ),
        ],
      ),
      body: async.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (_, _) => MarksMessage(
          icon: Icons.error_outline,
          message: 'teacher.marks.reportComments.error'.tr(),
          onRetry: () => ref.invalidate(reportCommentsProvider(_key)),
        ),
        data: (data) {
          if (_controllers.isEmpty) _sync(data);
          return _body(data);
        },
      ),
    );
  }

  Widget _body(SubjectReportComments data) {
    final theme = Theme.of(context);
    final notice = data.finalized
        ? 'teacher.marks.reportComments.finalized'.tr()
        : !data.canComment
        ? 'teacher.marks.reportComments.readOnly'.tr()
        : !data.shown
        ? 'teacher.marks.reportComments.hidden'.tr()
        : null;
    return ListView(
      padding: const EdgeInsets.all(
        AppSpacing.space16,
      ).withBottomInset(context),
      children: [
        Text(
          'teacher.marks.reportComments.help'.tr(),
          style: theme.textTheme.bodyMedium?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
        if (notice != null) ...[
          const SizedBox(height: AppSpacing.space12),
          Text(notice, style: theme.textTheme.bodyMedium),
        ],
        const SizedBox(height: AppSpacing.space16),
        if (data.students.isEmpty)
          Text('teacher.marks.reportComments.noStudents'.tr()),
        for (final student in data.students)
          Padding(
            padding: const EdgeInsets.only(bottom: AppSpacing.space16),
            child: TextField(
              controller: _controllers[student.studentId],
              enabled: data.canComment,
              minLines: 2,
              maxLines: 5,
              maxLength: _maxLength,
              textCapitalization: TextCapitalization.sentences,
              decoration: InputDecoration(
                labelText: student.name,
                border: const OutlineInputBorder(),
              ),
            ),
          ),
      ],
    );
  }
}
