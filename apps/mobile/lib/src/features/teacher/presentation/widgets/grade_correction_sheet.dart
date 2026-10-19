import 'package:dio/dio.dart';
import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/api/api_exception.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/grade_entry_providers.dart';
import '../../domain/grade_entry.dart';

/// Bottom sheet for correcting one published grade.
///
/// Published grades are frozen, so the correction is filed as a revision
/// (`POST .../submissions/{id}/revisions`) with a reason. Students and parents keep seeing the
/// published score until a school admin or principal approves it from the approvals queue. While a
/// revision is pending the sheet shows it instead, with a withdraw action so the teacher can file
/// a different one. Resolves `true` when anything changed, so the caller re-reads the grid.
class GradeCorrectionSheet extends ConsumerStatefulWidget {
  const GradeCorrectionSheet({
    required this.gradebookId,
    required this.studentLabel,
    required this.entry,
    super.key,
  });

  final String gradebookId;
  final String studentLabel;
  final StudentGradeEntry entry;

  static Future<bool?> show(
    BuildContext context, {
    required String gradebookId,
    required String studentLabel,
    required StudentGradeEntry entry,
  }) {
    return showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      builder: (_) => GradeCorrectionSheet(
        gradebookId: gradebookId,
        studentLabel: studentLabel,
        entry: entry,
      ),
    );
  }

  @override
  ConsumerState<GradeCorrectionSheet> createState() =>
      _GradeCorrectionSheetState();
}

class _GradeCorrectionSheetState extends ConsumerState<GradeCorrectionSheet> {
  final _formKey = GlobalKey<FormState>();
  late final TextEditingController _scoreController;
  final _reasonController = TextEditingController();

  bool _busy = false;
  String? _errorKey;

  GradeCell get _cell => widget.entry.cell;

  @override
  void initState() {
    super.initState();
    _scoreController = TextEditingController(text: _format(_cell.score));
  }

  @override
  void dispose() {
    _scoreController.dispose();
    _reasonController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_busy || !(_formKey.currentState?.validate() ?? false)) return;
    final text = _scoreController.text.trim();
    final score = text.isEmpty ? null : double.parse(text);

    await _run(
      () => ref
          .read(gradeEntryClientProvider)
          .requestRevision(
            widget.gradebookId,
            widget.entry.submissionId,
            reason: _reasonController.text.trim(),
            scoresByGradeId: {_cell.id: score},
          ),
    );
  }

  Future<void> _withdraw(GradeRevision revision) => _run(
    () => ref
        .read(gradeEntryClientProvider)
        .withdrawRevision(widget.gradebookId, revision.id),
  );

  Future<void> _run(Future<Object?> Function() call) async {
    setState(() {
      _busy = true;
      _errorKey = null;
    });
    try {
      await call();
      if (mounted) Navigator.of(context).pop(true);
    } on DioException catch (error) {
      if (mounted)
        setState(() => _errorKey = _messageKeyFor(error.apiError?.code));
    } catch (_) {
      if (mounted)
        setState(() => _errorKey = 'teacher.grades.correction.errorGeneric');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  String _messageKeyFor(String? code) => switch (code) {
    'GRADE_REVISION_ALREADY_PENDING' =>
      'teacher.grades.correction.errorPending',
    'GRADE_SCORE_EXCEEDS_MAX' => 'teacher.grades.correction.errorOverMax',
    'AUTHZ_FORBIDDEN' => 'teacher.grades.createAssessment.errorForbidden',
    'VALIDATION_FAILED' => 'teacher.grades.correction.errorNoChange',
    _ => 'teacher.grades.correction.errorGeneric',
  };

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final bottomInset = MediaQuery.of(context).viewInsets.bottom;
    final revision = widget.entry.latestRevision;
    final pending = revision != null && revision.isPending ? revision : null;
    final rejected = revision != null && revision.isRejected ? revision : null;
    final maxLabel = _format(_cell.maxScore);

    return Padding(
      padding: EdgeInsets.fromLTRB(
        AppSpacing.space16,
        AppSpacing.space16,
        AppSpacing.space16,
        AppSpacing.space16 + bottomInset,
      ),
      child: Form(
        key: _formKey,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              'teacher.grades.correction.title'.tr(),
              style: theme.textTheme.titleMedium,
            ),
            const SizedBox(height: AppSpacing.space4),
            Text(
              '${widget.studentLabel} · ${_cell.label}',
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: AppSpacing.space12),
            Text(
              'teacher.grades.correction.published'.tr(
                namedArgs: {
                  'score': _format(_cell.score, empty: '—'),
                  'max': maxLabel,
                },
              ),
              style: theme.textTheme.bodyMedium,
            ),
            const SizedBox(height: AppSpacing.space12),
            if (pending != null) ...[
              Text(
                'teacher.grades.correction.pending'.tr(
                  namedArgs: {
                    'score': _format(
                      pending.changeFor(_cell.id)?.newScore,
                      empty: '—',
                    ),
                  },
                ),
                style: theme.textTheme.bodyMedium?.copyWith(
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(height: AppSpacing.space4),
              Text(
                'teacher.grades.correction.reasonShown'.tr(
                  namedArgs: {'reason': pending.reason},
                ),
                style: theme.textTheme.bodySmall,
              ),
              const SizedBox(height: AppSpacing.space8),
              Text(
                'teacher.grades.correction.pendingHint'.tr(),
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ] else ...[
              if (rejected != null) ...[
                Text(
                  'teacher.grades.correction.lastRejected'.tr(
                    namedArgs: {'reason': rejected.rejectionReason ?? ''},
                  ),
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.error,
                  ),
                ),
                const SizedBox(height: AppSpacing.space12),
              ],
              TextFormField(
                controller: _scoreController,
                autofocus: true,
                keyboardType: const TextInputType.numberWithOptions(
                  decimal: true,
                ),
                inputFormatters: [
                  FilteringTextInputFormatter.allow(RegExp(r'[0-9.]')),
                ],
                decoration: InputDecoration(
                  labelText: 'teacher.grades.correction.newScore'.tr(),
                  suffixText: '/ $maxLabel',
                ),
                validator: (value) {
                  final text = (value ?? '').trim();
                  if (text.isEmpty) return null;
                  final parsed = double.tryParse(text);
                  if (parsed == null || !_cell.scoreInRange(parsed)) {
                    return 'teacher.grades.entry.overMax'.tr(
                      namedArgs: {'max': maxLabel},
                    );
                  }
                  if (parsed == _cell.score) {
                    return 'teacher.grades.correction.errorNoChange'.tr();
                  }
                  return null;
                },
              ),
              const SizedBox(height: AppSpacing.space12),
              TextFormField(
                controller: _reasonController,
                maxLength: 2000,
                minLines: 2,
                maxLines: 4,
                textCapitalization: TextCapitalization.sentences,
                decoration: InputDecoration(
                  labelText: 'teacher.grades.correction.reason'.tr(),
                  hintText: 'teacher.grades.correction.reasonHint'.tr(),
                ),
                validator: (value) => (value == null || value.trim().isEmpty)
                    ? 'teacher.grades.correction.reasonRequired'.tr()
                    : null,
              ),
              Text(
                'teacher.grades.correction.approvalHint'.tr(),
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ],
            if (_errorKey != null) ...[
              const SizedBox(height: AppSpacing.space12),
              Text(
                _errorKey!.tr(),
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.error,
                ),
              ),
            ],
            const SizedBox(height: AppSpacing.space20),
            if (pending != null)
              OutlinedButton(
                onPressed: _busy ? null : () => _withdraw(pending),
                child: _progressOr('teacher.grades.correction.withdraw'),
              )
            else
              FilledButton(
                onPressed: _busy ? null : _submit,
                child: _progressOr('teacher.grades.correction.submit'),
              ),
          ],
        ),
      ),
    );
  }

  Widget _progressOr(String labelKey) => _busy
      ? const SizedBox.square(
          dimension: 18,
          child: CircularProgressIndicator(strokeWidth: 2),
        )
      : Text(labelKey.tr());

  static String _format(double? value, {String empty = ''}) {
    if (value == null) return empty;
    return value == value.roundToDouble()
        ? value.toInt().toString()
        : value.toString();
  }
}
