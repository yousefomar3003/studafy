import 'package:dio/dio.dart';
import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/mark_sheet_providers.dart';
import '../../domain/mark_sheet.dart';
import 'mark_sheet_common.dart';

/// Bottom sheet for adding an assessment to one period of a section's mark sheet
/// (`POST .../assessments`). Offered only when the sheet reports `can_add_assessments`.
///
/// Only categories whose scope matches the period are offered — a term period takes term-scoped
/// categories, the annual period annual ones — mirroring the API's own check. Resolves to the new
/// assessment's status (`active`, or `proposed` when the subject requires approval), or null when
/// dismissed.
class AddMarkAssessmentSheet extends ConsumerStatefulWidget {
  const AddMarkAssessmentSheet({
    required this.sheet,
    required this.termId,
    super.key,
  });

  final MarkSheet sheet;
  final String? termId;

  static Future<String?> show(
    BuildContext context, {
    required MarkSheet sheet,
    required String? termId,
  }) => showModalBottomSheet<String>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (_) => AddMarkAssessmentSheet(sheet: sheet, termId: termId),
  );

  @override
  ConsumerState<AddMarkAssessmentSheet> createState() =>
      _AddMarkAssessmentSheetState();
}

class _AddMarkAssessmentSheetState
    extends ConsumerState<AddMarkAssessmentSheet> {
  final _formKey = GlobalKey<FormState>();
  final _name = TextEditingController();
  final _maxMarks = TextEditingController();
  final _weight = TextEditingController(text: '1');
  String? _categoryId;
  bool _mandatory = true;
  bool _saving = false;
  String? _error;

  late final List<MarkSheetCategory> _categories = [
    for (final category in widget.sheet.categories)
      if ((category.scope == 'term') == (widget.termId != null)) category,
  ];

  @override
  void initState() {
    super.initState();
    if (_categories.isNotEmpty) _categoryId = _categories.first.id;
  }

  @override
  void dispose() {
    _name.dispose();
    _maxMarks.dispose();
    _weight.dispose();
    super.dispose();
  }

  String? _positive(String? value) {
    final parsed = double.tryParse(value?.trim() ?? '');
    return parsed == null || parsed <= 0
        ? 'teacher.marks.addAssessment.positive'.tr()
        : null;
  }

  Future<void> _submit() async {
    if (!(_formKey.currentState?.validate() ?? false) || _categoryId == null) {
      return;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final status = await ref
          .read(markSheetClientProvider)
          .addAssessment(
            widget.sheet.sectionId,
            widget.sheet.subjectId,
            categoryId: _categoryId!,
            termId: widget.termId,
            name: _name.text.trim(),
            maxMarks: double.parse(_maxMarks.text.trim()),
            weight: double.parse(_weight.text.trim()),
            isMandatory: _mandatory,
          );
      if (mounted) Navigator.of(context).pop(status);
    } on DioException catch (error) {
      if (mounted) {
        setState(() {
          _saving = false;
          _error = markErrorMessage(error);
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(
            AppSpacing.space16,
            0,
            AppSpacing.space16,
            AppSpacing.space16,
          ),
          child: Form(
            key: _formKey,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  '${'teacher.marks.addAssessment.title'.tr()} · '
                  '${markPeriodLabel(widget.sheet, widget.termId)}',
                  style: theme.textTheme.titleLarge,
                ),
                const SizedBox(height: AppSpacing.space16),
                if (_categories.isEmpty)
                  Text('teacher.marks.addAssessment.noCategory'.tr())
                else ...[
                  TextFormField(
                    controller: _name,
                    decoration: InputDecoration(
                      labelText: 'teacher.marks.addAssessment.name'.tr(),
                    ),
                    textInputAction: TextInputAction.next,
                    validator: (value) => (value?.trim().isEmpty ?? true)
                        ? 'teacher.marks.addAssessment.nameRequired'.tr()
                        : null,
                  ),
                  const SizedBox(height: AppSpacing.space12),
                  DropdownButtonFormField<String>(
                    initialValue: _categoryId,
                    decoration: InputDecoration(
                      labelText: 'teacher.marks.addAssessment.category'.tr(),
                    ),
                    items: [
                      for (final category in _categories)
                        DropdownMenuItem(
                          value: category.id,
                          child: Text(category.name),
                        ),
                    ],
                    onChanged: (value) => setState(() => _categoryId = value),
                  ),
                  const SizedBox(height: AppSpacing.space12),
                  Row(
                    children: [
                      Expanded(
                        child: TextFormField(
                          controller: _maxMarks,
                          keyboardType: const TextInputType.numberWithOptions(
                            decimal: true,
                          ),
                          decoration: InputDecoration(
                            labelText: 'teacher.marks.addAssessment.maxMarks'
                                .tr(),
                          ),
                          validator: _positive,
                        ),
                      ),
                      const SizedBox(width: AppSpacing.space12),
                      Expanded(
                        child: TextFormField(
                          controller: _weight,
                          keyboardType: const TextInputType.numberWithOptions(
                            decimal: true,
                          ),
                          decoration: InputDecoration(
                            labelText: 'teacher.marks.addAssessment.weight'
                                .tr(),
                          ),
                          validator: _positive,
                        ),
                      ),
                    ],
                  ),
                  SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    title: Text('teacher.marks.addAssessment.mandatory'.tr()),
                    value: _mandatory,
                    onChanged: (value) => setState(() => _mandatory = value),
                  ),
                  if (_error != null)
                    Padding(
                      padding: const EdgeInsets.only(bottom: AppSpacing.space8),
                      child: Text(
                        _error!,
                        style: theme.textTheme.bodyMedium?.copyWith(
                          color: theme.colorScheme.error,
                        ),
                      ),
                    ),
                  FilledButton(
                    onPressed: _saving ? null : _submit,
                    child: Text('teacher.marks.addAssessment.submit'.tr()),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}
