import 'package:dio/dio.dart';
import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/api_exception.dart';
import '../../../core/api/generated/models/assignment.dart';
import '../../../core/api/generated/models/assignment_question_question_type.dart';
import '../../../core/api/generated/models/assignment_status.dart';
import '../../../core/api/generated/models/question_input.dart';
import '../../../core/api/generated/models/question_input_question_type.dart';
import '../../../core/api/generated/models/question_option_input.dart';
import '../../../core/api/generated/models/replace_questions_body.dart';
import '../../../core/api/generated/models/update_assignment_body.dart';
import '../../../core/api/generated/models/update_assignment_body_status.dart';
import '../../../core/auth/auth_providers.dart';
import '../../../design/layout/bottom_inset_padding.dart';
import '../../../design/tokens/app_spacing_tokens.dart';

/// The most options a multiple-choice question may have; the API refuses more.
const _maxOptions = 6;

/// Form-style editor for a `questions` assignment: multiple-choice and true/false questions, each
/// with its points and exactly one correct option. Saving replaces the whole question set
/// (`PUT .../questions`), and the API sets the assignment's total to the sum of the points.
///
/// A draft can be saved as-is or saved and published in one step. Once any student has handed in,
/// the API refuses edits (`ASSIGNMENT_QUESTIONS_LOCKED`) because changing the questions would
/// change what they answered. Pops `true` when something was saved.
class QuestionEditorScreen extends ConsumerStatefulWidget {
  const QuestionEditorScreen({required this.assignment, super.key});

  final Assignment assignment;

  @override
  ConsumerState<QuestionEditorScreen> createState() =>
      _QuestionEditorScreenState();
}

/// One question being edited. Controllers are owned here and disposed with the screen.
class _DraftQuestion {
  _DraftQuestion({
    required this.type,
    String prompt = '',
    String points = '1',
    List<String> options = const ['', ''],
    this.correctIndex = 0,
  }) : prompt = TextEditingController(text: prompt),
       points = TextEditingController(text: points),
       options = [
         for (final text in options) TextEditingController(text: text),
       ];

  QuestionInputQuestionType type;
  final TextEditingController prompt;
  final TextEditingController points;

  /// Multiple-choice option texts. Unused for true/false, whose two options are fixed.
  final List<TextEditingController> options;
  int correctIndex;

  void dispose() {
    prompt.dispose();
    points.dispose();
    for (final option in options) {
      option.dispose();
    }
  }
}

class _QuestionEditorScreenState extends ConsumerState<QuestionEditorScreen> {
  final _formKey = GlobalKey<FormState>();
  final List<_DraftQuestion> _questions = [];
  bool _saving = false;
  String? _errorKey;

  bool get _isDraft => widget.assignment.status == AssignmentStatus.draft;

  @override
  void initState() {
    super.initState();
    for (final question in widget.assignment.questions) {
      final trueFalse =
          question.questionType == AssignmentQuestionQuestionType.trueFalse;
      final correct = question.options.indexWhere((o) => o.isCorrect ?? false);
      _questions.add(
        _DraftQuestion(
          type: trueFalse
              ? QuestionInputQuestionType.trueFalse
              : QuestionInputQuestionType.multipleChoice,
          prompt: question.prompt,
          points: _formatPoints(question.points),
          options: trueFalse
              ? const ['', '']
              : [for (final option in question.options) option.text],
          correctIndex: correct < 0 ? 0 : correct,
        ),
      );
    }
    if (_questions.isEmpty) _addQuestion(notify: false);
  }

  @override
  void dispose() {
    for (final question in _questions) {
      question.dispose();
    }
    super.dispose();
  }

  static String _formatPoints(num points) =>
      points == points.roundToDouble() ? '${points.toInt()}' : '$points';

  void _addQuestion({bool notify = true}) {
    final question = _DraftQuestion(
      type: QuestionInputQuestionType.multipleChoice,
    );
    if (notify) {
      setState(() => _questions.add(question));
    } else {
      _questions.add(question);
    }
  }

  void _removeQuestion(_DraftQuestion question) {
    setState(() => _questions.remove(question));
    question.dispose();
  }

  void _move(int index, int delta) {
    final target = index + delta;
    if (target < 0 || target >= _questions.length) return;
    setState(() {
      final question = _questions.removeAt(index);
      _questions.insert(target, question);
    });
  }

  /// The localised fixed options of a true/false question, in the order they are stored.
  List<String> get _trueFalseTexts => [
    'teacher.questions.true'.tr(),
    'teacher.questions.false'.tr(),
  ];

  ReplaceQuestionsBody _body() => ReplaceQuestionsBody(
    questions: [
      for (final question in _questions)
        QuestionInput(
          questionType: question.type,
          prompt: question.prompt.text.trim(),
          points: num.parse(question.points.text.replaceAll(',', '.')),
          options: [
            for (final (index, text)
                in (question.type == QuestionInputQuestionType.trueFalse
                        ? _trueFalseTexts
                        : [
                            for (final option in question.options)
                              option.text.trim(),
                          ])
                    .indexed)
              QuestionOptionInput(
                text: text,
                isCorrect: index == question.correctIndex,
              ),
          ],
        ),
    ],
  );

  Future<void> _save({required bool publish}) async {
    if (!_formKey.currentState!.validate()) return;
    if (_questions.isEmpty) {
      setState(() => _errorKey = 'teacher.questions.errors.empty');
      return;
    }
    setState(() {
      _saving = true;
      _errorKey = null;
    });
    try {
      final api = ref.read(apiClientProvider).assignments;
      final saved = await api.replaceAssignmentQuestions(
        assignmentId: widget.assignment.id,
        body: _body(),
      );
      if (publish) {
        // The generated body serialises every field, so carry the stored values over.
        await api.updateAssignment(
          assignmentId: saved.id,
          body: UpdateAssignmentBody(
            title: saved.title,
            description: saved.description,
            instructions: saved.instructions,
            availableFrom: saved.availableFrom,
            dueAt: saved.dueAt,
            maxScore: saved.maxScore,
            allowLateSubmission: saved.allowLateSubmission,
            status: UpdateAssignmentBodyStatus.published,
          ),
        );
      }
      if (mounted) Navigator.of(context).pop(true);
    } on DioException catch (error) {
      setState(
        () => _errorKey = switch (error.apiError?.code) {
          'ASSIGNMENT_QUESTIONS_LOCKED' => 'teacher.questions.errors.locked',
          'ASSIGNMENT_QUESTIONS_REQUIRED' => 'teacher.questions.errors.empty',
          'VALIDATION_FAILED' => 'teacher.content.errors.validation',
          _ => 'teacher.questions.errors.save',
        },
      );
    } catch (_) {
      setState(() => _errorKey = 'teacher.questions.errors.save');
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  num get _totalPoints => _questions.fold<num>(
    0,
    (sum, question) =>
        sum + (num.tryParse(question.points.text.replaceAll(',', '.')) ?? 0),
  );

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;

    return Scaffold(
      appBar: AppBar(title: Text('teacher.questions.title'.tr())),
      body: Form(
        key: _formKey,
        child: ListView(
          padding: const EdgeInsets.all(
            AppSpacing.space16,
          ).withBottomInset(context),
          children: [
            Text(widget.assignment.title, style: textTheme.titleMedium),
            const SizedBox(height: AppSpacing.space4),
            Text(
              'teacher.questions.summary'.tr(
                namedArgs: {
                  'count': '${_questions.length}',
                  'points': _formatPoints(_totalPoints),
                },
              ),
              style: textTheme.bodySmall?.copyWith(
                color: colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: AppSpacing.space16),
            for (final (index, question) in _questions.indexed) ...[
              _QuestionCard(
                key: ObjectKey(question),
                number: index + 1,
                question: question,
                trueFalseTexts: _trueFalseTexts,
                enabled: !_saving,
                onChanged: () => setState(() {}),
                onRemove: _questions.length > 1
                    ? () => _removeQuestion(question)
                    : null,
                onMoveUp: index > 0 ? () => _move(index, -1) : null,
                onMoveDown: index < _questions.length - 1
                    ? () => _move(index, 1)
                    : null,
              ),
              const SizedBox(height: AppSpacing.space12),
            ],
            OutlinedButton.icon(
              key: const Key('questionEditorAdd'),
              onPressed: _saving ? null : _addQuestion,
              icon: const Icon(Icons.add),
              label: Text('teacher.questions.add'.tr()),
            ),
            if (_errorKey case final key?) ...[
              const SizedBox(height: AppSpacing.space12),
              Text(key.tr(), style: TextStyle(color: colorScheme.error)),
            ],
            const SizedBox(height: AppSpacing.space24),
            if (_isDraft) ...[
              FilledButton(
                key: const Key('questionEditorPublish'),
                onPressed: _saving ? null : () => _save(publish: true),
                child: Text('teacher.questions.saveAndPublish'.tr()),
              ),
              const SizedBox(height: AppSpacing.space8),
              OutlinedButton(
                key: const Key('questionEditorSave'),
                onPressed: _saving ? null : () => _save(publish: false),
                child: Text('teacher.questions.saveDraft'.tr()),
              ),
            ] else
              FilledButton(
                key: const Key('questionEditorSave'),
                onPressed: _saving ? null : () => _save(publish: false),
                child: Text('teacher.questions.save'.tr()),
              ),
            if (_saving)
              const Padding(
                padding: EdgeInsets.only(top: AppSpacing.space12),
                child: Center(child: CircularProgressIndicator()),
              ),
          ],
        ),
      ),
    );
  }
}

class _QuestionCard extends StatelessWidget {
  const _QuestionCard({
    required this.number,
    required this.question,
    required this.trueFalseTexts,
    required this.enabled,
    required this.onChanged,
    required this.onRemove,
    required this.onMoveUp,
    required this.onMoveDown,
    super.key,
  });

  final int number;
  final _DraftQuestion question;
  final List<String> trueFalseTexts;
  final bool enabled;
  final VoidCallback onChanged;
  final VoidCallback? onRemove;
  final VoidCallback? onMoveUp;
  final VoidCallback? onMoveDown;

  bool get _trueFalse => question.type == QuestionInputQuestionType.trueFalse;

  void _setType(QuestionInputQuestionType type) {
    question
      ..type = type
      ..correctIndex = 0;
    onChanged();
  }

  void _addOption() {
    question.options.add(TextEditingController());
    onChanged();
  }

  void _removeOption(int index) {
    final removed = question.options.removeAt(index);
    removed.dispose();
    if (question.correctIndex >= question.options.length) {
      question.correctIndex = question.options.length - 1;
    } else if (question.correctIndex > index) {
      question.correctIndex -= 1;
    }
    onChanged();
  }

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final optionTexts = _trueFalse
        ? trueFalseTexts
        : [for (final option in question.options) option.text];

    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(
          AppSpacing.space16,
          AppSpacing.space8,
          AppSpacing.space8,
          AppSpacing.space16,
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    'teacher.questions.number'.tr(
                      namedArgs: {'number': '$number'},
                    ),
                    style: textTheme.titleSmall,
                  ),
                ),
                IconButton(
                  icon: const Icon(Icons.arrow_upward),
                  tooltip: 'teacher.questions.moveUp'.tr(),
                  onPressed: enabled ? onMoveUp : null,
                ),
                IconButton(
                  icon: const Icon(Icons.arrow_downward),
                  tooltip: 'teacher.questions.moveDown'.tr(),
                  onPressed: enabled ? onMoveDown : null,
                ),
                IconButton(
                  icon: const Icon(Icons.delete_outline),
                  tooltip: 'teacher.questions.remove'.tr(),
                  onPressed: enabled ? onRemove : null,
                ),
              ],
            ),
            Padding(
              padding: const EdgeInsetsDirectional.only(end: AppSpacing.space8),
              child: SegmentedButton<QuestionInputQuestionType>(
                segments: [
                  ButtonSegment(
                    value: QuestionInputQuestionType.multipleChoice,
                    label: Text('teacher.questions.types.multipleChoice'.tr()),
                  ),
                  ButtonSegment(
                    value: QuestionInputQuestionType.trueFalse,
                    label: Text('teacher.questions.types.trueFalse'.tr()),
                  ),
                ],
                selected: {question.type},
                onSelectionChanged: enabled
                    ? (selection) => _setType(selection.single)
                    : null,
              ),
            ),
            const SizedBox(height: AppSpacing.space12),
            Padding(
              padding: const EdgeInsetsDirectional.only(end: AppSpacing.space8),
              child: TextFormField(
                controller: question.prompt,
                enabled: enabled,
                minLines: 1,
                maxLines: 4,
                maxLength: 2000,
                decoration: InputDecoration(
                  labelText: 'teacher.questions.prompt'.tr(),
                ),
                validator: (value) => value == null || value.trim().isEmpty
                    ? 'teacher.questions.errors.promptRequired'.tr()
                    : null,
              ),
            ),
            Padding(
              padding: const EdgeInsetsDirectional.only(end: AppSpacing.space8),
              child: TextFormField(
                controller: question.points,
                enabled: enabled,
                keyboardType: const TextInputType.numberWithOptions(
                  decimal: true,
                ),
                inputFormatters: [
                  FilteringTextInputFormatter.allow(RegExp(r'[0-9.,]')),
                ],
                decoration: InputDecoration(
                  labelText: 'teacher.questions.points'.tr(),
                ),
                onChanged: (_) => onChanged(),
                validator: (value) {
                  final points = num.tryParse(
                    (value ?? '').replaceAll(',', '.'),
                  );
                  return points == null || points <= 0
                      ? 'teacher.content.assignmentForm.pointsInvalid'.tr()
                      : null;
                },
              ),
            ),
            const SizedBox(height: AppSpacing.space12),
            Text(
              'teacher.questions.markCorrect'.tr(),
              style: textTheme.bodySmall,
            ),
            RadioGroup<int>(
              groupValue: question.correctIndex,
              onChanged: (value) {
                if (!enabled || value == null) return;
                question.correctIndex = value;
                onChanged();
              },
              child: Column(
                children: [
                  for (var index = 0; index < optionTexts.length; index++)
                    Row(
                      children: [
                        Radio<int>(
                          key: Key('questionOption$number-$index'),
                          value: index,
                          enabled: enabled,
                        ),
                        Expanded(
                          child: _trueFalse
                              ? Text(optionTexts[index])
                              : TextFormField(
                                  controller: question.options[index],
                                  enabled: enabled,
                                  maxLength: 500,
                                  decoration: InputDecoration(
                                    hintText: 'teacher.questions.optionHint'.tr(
                                      namedArgs: {'number': '${index + 1}'},
                                    ),
                                    counterText: '',
                                  ),
                                  validator: (value) =>
                                      value == null || value.trim().isEmpty
                                      ? 'teacher.questions.errors.optionRequired'
                                            .tr()
                                      : null,
                                ),
                        ),
                        if (!_trueFalse)
                          IconButton(
                            icon: const Icon(Icons.close),
                            tooltip: 'teacher.questions.removeOption'.tr(),
                            onPressed: enabled && question.options.length > 2
                                ? () => _removeOption(index)
                                : null,
                          ),
                      ],
                    ),
                ],
              ),
            ),
            if (!_trueFalse && question.options.length < _maxOptions)
              Align(
                alignment: AlignmentDirectional.centerStart,
                child: TextButton.icon(
                  onPressed: enabled ? _addOption : null,
                  icon: const Icon(Icons.add),
                  label: Text('teacher.questions.addOption'.tr()),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
