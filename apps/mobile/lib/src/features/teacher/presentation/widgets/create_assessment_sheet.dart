import 'package:dio/dio.dart';
import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/api/api_exception.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/grade_entry_providers.dart';

/// Bottom sheet that adds an assessment to a gradebook via
/// `POST /api/grades/gradebooks/{id}/assessments`: a label, a maximum score and an optional
/// weight, written as an ungraded cell into every draft submission. Resolves the new assessment
/// label on success so the caller can jump straight into entering it.
class CreateAssessmentSheet extends ConsumerStatefulWidget {
  const CreateAssessmentSheet({required this.gradebookId, super.key});

  final String gradebookId;

  static Future<String?> show(BuildContext context, {required String gradebookId}) {
    return showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      builder: (_) => CreateAssessmentSheet(gradebookId: gradebookId),
    );
  }

  @override
  ConsumerState<CreateAssessmentSheet> createState() => _CreateAssessmentSheetState();
}

class _CreateAssessmentSheetState extends ConsumerState<CreateAssessmentSheet> {
  final _formKey = GlobalKey<FormState>();
  final _labelController = TextEditingController();
  final _maxScoreController = TextEditingController(text: '100');
  final _weightController = TextEditingController(text: '1');

  bool _submitting = false;
  String? _errorKey;

  @override
  void dispose() {
    _labelController.dispose();
    _maxScoreController.dispose();
    _weightController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_submitting || !(_formKey.currentState?.validate() ?? false)) return;

    final label = _labelController.text.trim();
    final maxScore = double.parse(_maxScoreController.text.trim());
    final weight = double.tryParse(_weightController.text.trim()) ?? 1;

    setState(() {
      _submitting = true;
      _errorKey = null;
    });

    try {
      await ref.read(gradeEntryClientProvider).createAssessment(
            widget.gradebookId,
            label: label,
            maxScore: maxScore,
            weight: weight,
          );
      if (mounted) Navigator.of(context).pop(label);
    } on DioException catch (error) {
      setState(() => _errorKey = _messageKeyFor(error.apiError?.code));
    } catch (_) {
      setState(() => _errorKey = 'teacher.grades.createAssessment.errorGeneric');
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  String _messageKeyFor(String? code) => switch (code) {
        'AUTHZ_FORBIDDEN' => 'teacher.grades.createAssessment.errorForbidden',
        'VALIDATION_FAILED' => 'teacher.grades.createAssessment.errorValidation',
        _ => 'teacher.grades.createAssessment.errorGeneric',
      };

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final bottomInset = MediaQuery.of(context).viewInsets.bottom;

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
            Text('teacher.grades.createAssessment.title'.tr(), style: theme.textTheme.titleMedium),
            const SizedBox(height: AppSpacing.space16),
            TextFormField(
              controller: _labelController,
              autofocus: true,
              textCapitalization: TextCapitalization.words,
              decoration: InputDecoration(
                labelText: 'teacher.grades.createAssessment.labelField'.tr(),
                hintText: 'teacher.grades.createAssessment.labelHint'.tr(),
              ),
              validator: (value) => (value == null || value.trim().isEmpty)
                  ? 'teacher.grades.createAssessment.labelRequired'.tr()
                  : null,
            ),
            const SizedBox(height: AppSpacing.space12),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: TextFormField(
                    controller: _maxScoreController,
                    keyboardType: const TextInputType.numberWithOptions(decimal: true),
                    inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9.]'))],
                    decoration: InputDecoration(
                      labelText: 'teacher.grades.createAssessment.maxScoreField'.tr(),
                    ),
                    validator: _positiveNumberValidator,
                  ),
                ),
                const SizedBox(width: AppSpacing.space12),
                Expanded(
                  child: TextFormField(
                    controller: _weightController,
                    keyboardType: const TextInputType.numberWithOptions(decimal: true),
                    inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9.]'))],
                    decoration: InputDecoration(
                      labelText: 'teacher.grades.createAssessment.weightField'.tr(),
                    ),
                    validator: _positiveNumberValidator,
                  ),
                ),
              ],
            ),
            if (_errorKey != null) ...[
              const SizedBox(height: AppSpacing.space12),
              Text(
                _errorKey!.tr(),
                style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.error),
              ),
            ],
            const SizedBox(height: AppSpacing.space20),
            FilledButton(
              onPressed: _submitting ? null : _submit,
              child: _submitting
                  ? const SizedBox.square(
                      dimension: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : Text('teacher.grades.createAssessment.submit'.tr()),
            ),
          ],
        ),
      ),
    );
  }

  String? _positiveNumberValidator(String? value) {
    final parsed = double.tryParse((value ?? '').trim());
    if (parsed == null || parsed <= 0) {
      return 'teacher.grades.createAssessment.positiveNumber'.tr();
    }
    return null;
  }
}
