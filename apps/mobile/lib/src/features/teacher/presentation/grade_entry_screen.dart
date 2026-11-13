import 'package:dio/dio.dart';
import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/api_exception.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/grade_entry_providers.dart';
import '../application/teacher_providers.dart';
import '../domain/grade_entry.dart';
import 'widgets/create_assessment_sheet.dart';
import 'widgets/grade_correction_sheet.dart';
import 'widgets/grade_entry_row.dart';
import 'widgets/grade_numeric_keypad.dart';
import 'widgets/grade_submit_bar.dart';

/// Gradebook entry for one class, one assessment at a time.
///
/// Pushed from the class-detail screen, so it owns its [Scaffold]. It resolves (lazily creating)
/// the class's gradebook, then the entry grid. The teacher picks an assessment — or adds one —
/// and enters scores for the whole roster on a docked numeric keypad: each keystroke autosaves
/// on a short debounce, an out-of-range value is blocked inline, and "submit for approval" locks
/// every draft student behind a confirmation. A published grade is corrected from its row through
/// [GradeCorrectionSheet] (approved by a school admin or principal before students see it), and a
/// returned one is unlocked back to draft from its row.
class GradeEntryScreen extends ConsumerStatefulWidget {
  const GradeEntryScreen({
    required this.classId,
    required this.classCode,
    super.key,
  });

  final String classId;
  final String classCode;

  @override
  ConsumerState<GradeEntryScreen> createState() => _GradeEntryScreenState();
}

class _GradeEntryScreenState extends ConsumerState<GradeEntryScreen> {
  final ScrollController _scrollController = ScrollController();

  GradeEntryController? _controller;
  String? _controllerGradebookId;
  String? _selectedAssessment;
  String? _focusedGradeId;
  bool _submitting = false;

  @override
  void dispose() {
    _controller?.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  GradeEntryController _controllerFor(String gradebookId) {
    if (_controller != null && _controllerGradebookId == gradebookId) {
      return _controller!;
    }
    _controller?.dispose();
    _controller = GradeEntryController(
      client: ref.read(gradeEntryClientProvider),
      gradebookId: gradebookId,
    );
    _controllerGradebookId = gradebookId;
    return _controller!;
  }

  void _openAssessment(String label) => setState(() {
    _selectedAssessment = label;
    _focusedGradeId = null;
  });

  void _closeAssessment() => setState(() {
    _selectedAssessment = null;
    _focusedGradeId = null;
  });

  @override
  Widget build(BuildContext context) {
    // Resolve roster names for this class (see classRosterNamesProvider).
    ref.watch(classRosterNamesProvider(widget.classId));
    final gradebook = ref.watch(gradebookForClassProvider(widget.classId));

    return Scaffold(
      appBar: AppBar(
        title: Text(widget.classCode),
        // `BackButton` (not a raw `IconButton`) so the tap target picks up
        // `MaterialLocalizations`' own "Back" tooltip — TalkBack/VoiceOver otherwise announce
        // this as an unlabeled button (ST-294 a11y audit).
        leading: _selectedAssessment != null
            ? BackButton(onPressed: _closeAssessment)
            : null,
        bottom: _selectedAssessment == null
            ? null
            : PreferredSize(
                preferredSize: const Size.fromHeight(28),
                child: Align(
                  alignment: AlignmentDirectional.centerStart,
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(
                      AppSpacing.space16,
                      0,
                      AppSpacing.space16,
                      AppSpacing.space8,
                    ),
                    child: Text(
                      _selectedAssessment!,
                      style: Theme.of(context).textTheme.bodyMedium,
                    ),
                  ),
                ),
              ),
      ),
      body: gradebook.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (_, _) => _ErrorRetry(
          messageKey: 'teacher.grades.loadError',
          onRetry: () =>
              ref.invalidate(gradebookForClassProvider(widget.classId)),
        ),
        data: (gradebookRef) => _buildGrid(gradebookRef.id),
      ),
    );
  }

  Widget _buildGrid(String gradebookId) {
    final gridAsync = ref.watch(gradeEntryGridProvider(gradebookId));

    return gridAsync.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (_, _) => _ErrorRetry(
        messageKey: 'teacher.grades.loadError',
        onRetry: () => ref.invalidate(gradeEntryGridProvider(gradebookId)),
      ),
      data: (grid) {
        final controller = _controllerFor(gradebookId);
        if (_selectedAssessment == null) {
          return _AssessmentList(
            grid: grid,
            onPick: _openAssessment,
            onAdd: () async {
              final created = await CreateAssessmentSheet.show(
                context,
                gradebookId: gradebookId,
              );
              if (created == null || !mounted) return;
              // The new assessment's cells were seeded server-side; re-read the grid before
              // opening it so its roster isn't empty.
              ref.invalidate(gradeEntryGridProvider(gradebookId));
              _openAssessment(created);
            },
            onRefresh: () async =>
                ref.invalidate(gradeEntryGridProvider(gradebookId)),
          );
        }
        return _buildEntry(gradebookId, grid, controller);
      },
    );
  }

  Widget _buildEntry(
    String gradebookId,
    GradeEntryGrid grid,
    GradeEntryController controller,
  ) {
    final label = _selectedAssessment!;
    final rows = grid.rowsFor(label);
    controller.seed(rows);

    final editableIds = {
      for (final r in rows)
        if (r.isEditable) r.cell.id,
    };
    if (_focusedGradeId != null && !editableIds.contains(_focusedGradeId)) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) setState(() => _focusedGradeId = null);
      });
    }

    if (rows.isEmpty) {
      return const _CenteredMessage(
        icon: Icons.group_off_outlined,
        messageKey: 'teacher.grades.entry.noStudents',
      );
    }

    final maxScore = rows.first.cell.maxScore;

    return AnimatedBuilder(
      animation: controller,
      builder: (context, _) {
        final focusedId = _focusedGradeId;
        return Column(
          children: [
            Expanded(
              child: RefreshIndicator(
                onRefresh: () async {
                  await controller.flush();
                  ref.invalidate(gradeEntryGridProvider(gradebookId));
                },
                child: ListView.builder(
                  controller: _scrollController,
                  padding: const EdgeInsets.symmetric(
                    horizontal: AppSpacing.space16,
                  ),
                  itemCount: rows.length,
                  itemBuilder: (context, index) {
                    final row = rows[index];
                    return _StudentRow(
                      row: row,
                      controller: controller,
                      isFocused: row.cell.id == focusedId,
                      onTap: row.status.isRejected
                          ? () => _confirmAndUnlock(gradebookId, row)
                          : () => setState(() => _focusedGradeId = row.cell.id),
                      onCorrect: row.status.isPublished
                          ? (studentLabel) =>
                                _openCorrection(gradebookId, row, studentLabel)
                          : null,
                    );
                  },
                ),
              ),
            ),
            if (focusedId != null)
              GradeNumericKeypad(
                isLastRow: _isLastEditable(rows, focusedId),
                onDigit: (digit) => controller.setText(
                  focusedId,
                  controller.textFor(focusedId) + digit,
                  maxScore: maxScore,
                ),
                onDot: () {
                  final current = controller.textFor(focusedId);
                  if (!current.contains('.')) {
                    controller.setText(
                      focusedId,
                      current.isEmpty ? '0.' : '$current.',
                      maxScore: maxScore,
                    );
                  }
                },
                onBackspace: () {
                  final current = controller.textFor(focusedId);
                  if (current.isNotEmpty) {
                    controller.setText(
                      focusedId,
                      current.substring(0, current.length - 1),
                      maxScore: maxScore,
                    );
                  }
                },
                onClear: () =>
                    controller.setText(focusedId, '', maxScore: maxScore),
                onNext: () => _advance(rows, focusedId),
              ),
            GradeSubmitBar(
              saveStatus: controller.status,
              lastSavedAt: controller.lastSavedAt,
              errorCode: controller.errorCode,
              submittableCount: grid.submittableSubmissions.length,
              isSubmitting: _submitting,
              onSubmit: () => _confirmAndSubmit(gradebookId, grid, controller),
              onRetrySave: () {
                if (controller.errorCode == 'GRADE_CONCURRENT_EDIT') {
                  controller.resetDrafts();
                  ref.invalidate(gradeEntryGridProvider(gradebookId));
                } else {
                  controller.flush();
                }
              },
            ),
          ],
        );
      },
    );
  }

  bool _isLastEditable(List<StudentGradeEntry> rows, String gradeId) {
    final editable = rows.where((r) => r.isEditable).toList();
    return editable.isNotEmpty && editable.last.cell.id == gradeId;
  }

  void _advance(List<StudentGradeEntry> rows, String currentId) {
    final editable = rows.where((r) => r.isEditable).toList();
    final index = editable.indexWhere((r) => r.cell.id == currentId);
    if (index == -1 || index == editable.length - 1) {
      setState(() => _focusedGradeId = null);
      _controller?.flush();
      return;
    }
    final nextId = editable[index + 1].cell.id;
    setState(() => _focusedGradeId = nextId);

    final rowIndex = rows.indexWhere((r) => r.cell.id == nextId);
    if (rowIndex != -1 && _scrollController.hasClients) {
      _scrollController.animateTo(
        (rowIndex * 64.0).clamp(
          0.0,
          _scrollController.position.maxScrollExtent,
        ),
        duration: const Duration(milliseconds: 200),
        curve: Curves.easeOut,
      );
    }
  }

  Future<void> _openCorrection(
    String gradebookId,
    StudentGradeEntry row,
    String studentLabel,
  ) async {
    await _controller?.flush();
    if (!mounted) return;
    final changed = await GradeCorrectionSheet.show(
      context,
      gradebookId: gradebookId,
      studentLabel: studentLabel,
      entry: row,
    );
    if (changed != true || !mounted) return;
    ref.invalidate(gradeEntryGridProvider(gradebookId));
    ScaffoldMessenger.of(context)
      ..clearSnackBars()
      ..showSnackBar(
        SnackBar(content: Text('teacher.grades.correction.updated'.tr())),
      );
  }

  /// A returned submission goes back to draft only on the teacher's say-so: the reviewer's reason
  /// is shown first, since unlocking clears it.
  Future<void> _confirmAndUnlock(
    String gradebookId,
    StudentGradeEntry row,
  ) async {
    final reason = row.rejectionReason;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text('teacher.grades.unlock.title'.tr()),
        content: Text(
          reason == null || reason.isEmpty
              ? 'teacher.grades.unlock.body'.tr()
              : 'teacher.grades.unlock.bodyWithReason'.tr(
                  namedArgs: {'reason': reason},
                ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: Text(
              MaterialLocalizations.of(dialogContext).cancelButtonLabel,
            ),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: Text('teacher.grades.unlock.confirm'.tr()),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;

    String message;
    try {
      await ref
          .read(gradeEntryClientProvider)
          .unlockSubmission(
            gradebookId,
            row.submissionId,
            updatedAt: row.submissionUpdatedAt,
          );
      message = 'teacher.grades.unlock.success'.tr();
    } on DioException catch (error) {
      message = error.apiError?.code == 'GRADE_CONCURRENT_EDIT'
          ? 'teacher.grades.entry.saveConflict'.tr()
          : 'teacher.grades.unlock.failed'.tr();
    }
    if (!mounted) return;
    ref.invalidate(gradeEntryGridProvider(gradebookId));
    ScaffoldMessenger.of(context)
      ..clearSnackBars()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  Future<void> _confirmAndSubmit(
    String gradebookId,
    GradeEntryGrid grid,
    GradeEntryController controller,
  ) async {
    final submittable = grid.submittableSubmissions;
    if (submittable.isEmpty) return;

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text('teacher.grades.submit.title'.tr()),
        content: Text(
          'teacher.grades.submit.body'.tr(
            namedArgs: {'count': '${submittable.length}'},
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: Text(
              MaterialLocalizations.of(dialogContext).cancelButtonLabel,
            ),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: Text('teacher.grades.submit.confirm'.tr()),
          ),
        ],
      ),
    );
    if (confirmed != true) return;

    setState(() => _submitting = true);
    final result = await controller.submitAll(submittable);
    if (!mounted) return;

    setState(() {
      _submitting = false;
      _focusedGradeId = null;
    });
    ref.invalidate(gradeEntryGridProvider(gradebookId));

    final message = result.hadFailures
        ? 'teacher.grades.submit.partial'.tr(
            namedArgs: {
              'submitted': '${result.submitted}',
              'failed': '${result.failed.length}',
            },
          )
        : 'teacher.grades.submit.success'.tr(
            namedArgs: {'count': '${result.submitted}'},
          );
    ScaffoldMessenger.of(context)
      ..clearSnackBars()
      ..showSnackBar(SnackBar(content: Text(message)));
  }
}

// ---------------------------------------------------------------------------
// Assessment list
// ---------------------------------------------------------------------------

class _AssessmentList extends StatelessWidget {
  const _AssessmentList({
    required this.grid,
    required this.onPick,
    required this.onAdd,
    required this.onRefresh,
  });

  final GradeEntryGrid grid;
  final ValueChanged<String> onPick;
  final VoidCallback onAdd;
  final Future<void> Function() onRefresh;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final assessments = grid.assessments;

    return RefreshIndicator(
      onRefresh: onRefresh,
      child: ListView(
        padding: const EdgeInsets.all(AppSpacing.space16),
        children: [
          Text(
            'teacher.grades.list.rosterCount'.tr(
              namedArgs: {'count': '${grid.studentCount}'},
            ),
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: AppSpacing.space12),
          if (assessments.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: AppSpacing.space32),
              child: Column(
                children: [
                  Icon(
                    Icons.assignment_outlined,
                    size: 32,
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                  const SizedBox(height: AppSpacing.space12),
                  Text(
                    'teacher.grades.list.empty'.tr(),
                    textAlign: TextAlign.center,
                    style: theme.textTheme.bodyMedium?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                ],
              ),
            )
          else
            for (final assessment in assessments)
              Card(
                margin: const EdgeInsets.only(bottom: AppSpacing.space8),
                child: ListTile(
                  title: Text(assessment.label),
                  subtitle: Text(
                    'teacher.grades.list.assessmentMeta'.tr(
                      namedArgs: {
                        'max': _trim(assessment.maxScore),
                        'weight': _trim(assessment.weight),
                      },
                    ),
                  ),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => onPick(assessment.label),
                ),
              ),
          const SizedBox(height: AppSpacing.space8),
          OutlinedButton.icon(
            onPressed: onAdd,
            icon: const Icon(Icons.add),
            label: Text('teacher.grades.list.addAssessment'.tr()),
          ),
        ],
      ),
    );
  }

  static String _trim(double value) => value == value.roundToDouble()
      ? value.toInt().toString()
      : value.toString();
}

class _StudentRow extends ConsumerWidget {
  const _StudentRow({
    required this.row,
    required this.controller,
    required this.isFocused,
    required this.onTap,
    this.onCorrect,
  });

  final StudentGradeEntry row;
  final GradeEntryController controller;
  final bool isFocused;
  final VoidCallback onTap;

  /// Set for a published row: opens the correction sheet for this student.
  final ValueChanged<String>? onCorrect;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final name = ref.watch(rosterStudentNameProvider(row.studentId));
    final label =
        name ??
        'teacher.class.unknownStudent'.tr(
          namedArgs: {'id': _shortId(row.studentId)},
        );

    return GradeEntryRow(
      studentLabel: label,
      scoreText: controller.textFor(row.cell.id),
      maxScore: row.cell.maxScore,
      status: row.status,
      isFocused: isFocused,
      isOutOfRange: controller.isOutOfRange(row.cell.id, row.cell.maxScore),
      isDirty: controller.isDirty(row.cell.id),
      onTap: onTap,
      onLockedTap: onCorrect == null ? null : () => onCorrect!(label),
      note: _noteFor(row),
    );
  }

  static String? _noteFor(StudentGradeEntry row) {
    if (!row.status.isPublished) return null;
    final revision = row.latestRevision;
    final change = revision?.changeFor(row.cell.id);
    if (revision != null && change != null) {
      if (revision.isPending) {
        return 'teacher.grades.correction.rowPending'.tr(
          namedArgs: {'score': _formatScore(change.newScore)},
        );
      }
      if (revision.isRejected) {
        return 'teacher.grades.correction.rowRejected'.tr();
      }
    }
    return 'teacher.grades.correction.tapToCorrect'.tr();
  }

  static String _formatScore(double? value) {
    if (value == null) return '—';
    return value == value.roundToDouble()
        ? value.toInt().toString()
        : value.toString();
  }

  static String _shortId(String id) =>
      id.length <= 6 ? id : id.substring(id.length - 6);
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

class _CenteredMessage extends StatelessWidget {
  const _CenteredMessage({required this.icon, required this.messageKey});

  final IconData icon;
  final String messageKey;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 32, color: theme.colorScheme.onSurfaceVariant),
            const SizedBox(height: AppSpacing.space12),
            Text(
              messageKey.tr(),
              textAlign: TextAlign.center,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ErrorRetry extends StatelessWidget {
  const _ErrorRetry({required this.messageKey, required this.onRetry});

  final String messageKey;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.error_outline,
              size: 32,
              color: theme.colorScheme.onSurfaceVariant,
            ),
            const SizedBox(height: AppSpacing.space12),
            Text(
              messageKey.tr(),
              textAlign: TextAlign.center,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: AppSpacing.space12),
            OutlinedButton(
              onPressed: onRetry,
              child: Text('teacher.grades.retry'.tr()),
            ),
          ],
        ),
      ),
    );
  }
}
