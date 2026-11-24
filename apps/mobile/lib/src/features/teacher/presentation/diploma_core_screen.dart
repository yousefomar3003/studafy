import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../design/layout/bottom_inset_padding.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/diploma_core_providers.dart';
import '../domain/diploma_core.dart';
import 'widgets/mark_sheet_common.dart';

/// IB Diploma core grades (000263) for the section of a class whose grade uses the Diploma total:
/// each student's Theory of Knowledge and Extended Essay grade (A–E) and CAS, final or predicted,
/// saved together. Entered by the section's teachers (TOK and EE supervisors) from the app;
/// leadership enters them on the web.
///
/// Pushed from [TeacherClassDetailScreen] with the class's section. Read-only once the year is
/// closed; predicted grades only while the school records predicted grades for the grade.
class DiplomaCoreScreen extends ConsumerStatefulWidget {
  const DiplomaCoreScreen({
    required this.sectionId,
    required this.classCode,
    super.key,
  });

  final String sectionId;
  final String classCode;

  @override
  ConsumerState<DiplomaCoreScreen> createState() => _DiplomaCoreScreenState();
}

class _DiplomaCoreScreenState extends ConsumerState<DiplomaCoreScreen> {
  DiplomaCoreKind _kind = DiplomaCoreKind.finalGrades;

  /// Unsaved changes of the chosen kind, by student id.
  final Map<String, DiplomaCoreValues> _edits = {};
  bool _saving = false;

  DiplomaCoreValues _current(DiplomaCoreStudent student) =>
      _edits[student.studentId] ?? student.of(_kind);

  Map<String, DiplomaCoreValues> _changes(SectionDiplomaCore data) => {
    for (final student in data.students)
      if (_edits[student.studentId] case final edit?)
        if (edit != student.of(_kind)) student.studentId: edit,
  };

  bool _canEdit(SectionDiplomaCore data) =>
      data.editable &&
      (_kind == DiplomaCoreKind.finalGrades || data.predictedEnabled);

  void _chooseKind(DiplomaCoreKind kind) {
    if (kind == _kind) return;
    setState(() {
      _kind = kind;
      _edits.clear();
    });
  }

  Future<void> _save(SectionDiplomaCore data) async {
    final changes = _changes(data);
    if (changes.isEmpty) return;
    setState(() => _saving = true);
    try {
      await ref
          .read(diplomaCoreClientProvider)
          .save(widget.sectionId, kind: _kind, grades: changes);
      if (!mounted) return;
      _edits.clear();
      ref.invalidate(diplomaCoreProvider(widget.sectionId));
      _snack('teacher.diploma.saved'.tr());
    } catch (error) {
      _snack(switch (markErrorCode(error)) {
        'DIPLOMA_TOTAL_DISABLED' => 'teacher.diploma.disabled'.tr(),
        'PREDICTED_GRADES_DISABLED' => 'teacher.diploma.predictedOff'.tr(),
        'ACADEMIC_CONFIG_LOCKED' => 'teacher.diploma.readOnly'.tr(),
        _ => markErrorMessage(error),
      });
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  void _snack(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..clearSnackBars()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  Widget build(BuildContext context) {
    final async = ref.watch(diplomaCoreProvider(widget.sectionId));
    final data = async.value;
    final dirty = data != null && _changes(data).isNotEmpty;
    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('teacher.diploma.title'.tr()),
            Text(
              data?.sectionLabel.isNotEmpty ?? false
                  ? data!.sectionLabel
                  : widget.classCode,
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
        ),
        actions: [
          if (data != null && _canEdit(data))
            TextButton(
              onPressed: dirty && !_saving ? () => _save(data) : null,
              child: _saving
                  ? const SizedBox.square(
                      dimension: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : Text('teacher.diploma.save'.tr()),
            ),
        ],
      ),
      body: async.when(
        skipLoadingOnReload: true,
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (_, _) => MarksMessage(
          icon: Icons.error_outline,
          message: 'teacher.diploma.error'.tr(),
          onRetry: () => ref.invalidate(diplomaCoreProvider(widget.sectionId)),
        ),
        data: _body,
      ),
    );
  }

  Widget _body(SectionDiplomaCore data) {
    final theme = Theme.of(context);
    final editable = _canEdit(data);
    final notice = !data.enabled
        ? 'teacher.diploma.disabled'.tr()
        : !data.editable
        ? 'teacher.diploma.readOnly'.tr()
        : _kind == DiplomaCoreKind.predicted && !data.predictedEnabled
        ? 'teacher.diploma.predictedOff'.tr()
        : null;
    return ListView(
      padding: const EdgeInsets.all(
        AppSpacing.space16,
      ).withBottomInset(context),
      children: [
        Text(
          'teacher.diploma.help'.tr(),
          style: theme.textTheme.bodyMedium?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: AppSpacing.space12),
        SegmentedButton<DiplomaCoreKind>(
          segments: [
            for (final kind in DiplomaCoreKind.values)
              ButtonSegment(
                value: kind,
                label: Text('teacher.diploma.kind.${kind.name}'.tr()),
              ),
          ],
          selected: {_kind},
          onSelectionChanged: (selection) => _chooseKind(selection.first),
        ),
        if (notice != null) ...[
          const SizedBox(height: AppSpacing.space12),
          Text(notice, style: theme.textTheme.bodyMedium),
        ],
        const SizedBox(height: AppSpacing.space16),
        if (data.students.isEmpty) Text('teacher.diploma.noStudents'.tr()),
        for (final student in data.students)
          _StudentCard(
            key: ValueKey('diploma-${student.studentId}-${_kind.name}'),
            name: student.name,
            values: _current(student),
            editable: editable,
            onChanged: (values) =>
                setState(() => _edits[student.studentId] = values),
          ),
      ],
    );
  }
}

class _StudentCard extends StatelessWidget {
  const _StudentCard({
    required this.name,
    required this.values,
    required this.editable,
    required this.onChanged,
    super.key,
  });

  final String name;
  final DiplomaCoreValues values;
  final bool editable;
  final ValueChanged<DiplomaCoreValues> onChanged;

  @override
  Widget build(BuildContext context) {
    Widget grade(String label, String? value, ValueChanged<String?> set) =>
        Expanded(
          child: DropdownButtonFormField<String?>(
            initialValue: value,
            isExpanded: true,
            decoration: InputDecoration(
              labelText: label,
              border: const OutlineInputBorder(),
            ),
            items: [
              DropdownMenuItem<String?>(
                child: Text('teacher.diploma.none'.tr()),
              ),
              for (final option in diplomaCoreGrades)
                DropdownMenuItem<String?>(value: option, child: Text(option)),
            ],
            onChanged: editable ? set : null,
          ),
        );
    final cas = switch (values.casComplete) {
      true => 'complete',
      false => 'incomplete',
      null => null,
    };
    return Card(
      margin: const EdgeInsets.only(bottom: AppSpacing.space12),
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(name, style: Theme.of(context).textTheme.titleSmall),
            const SizedBox(height: AppSpacing.space8),
            Row(
              children: [
                grade(
                  'teacher.diploma.tok'.tr(),
                  values.tok,
                  (value) => onChanged(values.copyWith(tok: () => value)),
                ),
                const SizedBox(width: AppSpacing.space8),
                grade(
                  'teacher.diploma.ee'.tr(),
                  values.ee,
                  (value) => onChanged(values.copyWith(ee: () => value)),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.space8),
            DropdownButtonFormField<String?>(
              initialValue: cas,
              isExpanded: true,
              decoration: InputDecoration(
                labelText: 'teacher.diploma.cas'.tr(),
                border: const OutlineInputBorder(),
              ),
              items: [
                DropdownMenuItem<String?>(
                  child: Text('teacher.diploma.none'.tr()),
                ),
                DropdownMenuItem<String?>(
                  value: 'complete',
                  child: Text('teacher.diploma.casComplete'.tr()),
                ),
                DropdownMenuItem<String?>(
                  value: 'incomplete',
                  child: Text('teacher.diploma.casIncomplete'.tr()),
                ),
              ],
              onChanged: editable
                  ? (value) => onChanged(
                      values.copyWith(
                        casComplete: () =>
                            value == null ? null : value == 'complete',
                      ),
                    )
                  : null,
            ),
          ],
        ),
      ),
    );
  }
}
