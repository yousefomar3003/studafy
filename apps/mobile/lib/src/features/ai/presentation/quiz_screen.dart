import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../application/ask_ai_providers.dart';
import '../application/quiz_controller.dart';
import '../application/quiz_providers.dart';
import '../domain/quiz_state.dart';
import 'widgets/quiz_question_view.dart';
import 'widgets/quiz_results_view.dart';
import 'widgets/quiz_setup_view.dart';

/// Quiz: pick materials, answer an MCQ/short-answer set one question at a time with instant
/// feedback, then review the round and optionally retry just what was missed.
///
/// Route-only (`/me/quiz`), like Ask AI. Reuses [askAiStudentIdProvider] — every `/api/ai/*`
/// route takes the same `{studentId}` path convention (the session's own user id), so a second,
/// identically-shaped provider would just be a copy of that one.
class QuizScreen extends ConsumerStatefulWidget {
  const QuizScreen({super.key});

  @override
  ConsumerState<QuizScreen> createState() => _QuizScreenState();
}

class _QuizScreenState extends ConsumerState<QuizScreen> {
  QuizController? _controller;

  @override
  void initState() {
    super.initState();
    final studentId = ref.read(askAiStudentIdProvider);
    if (studentId != null) {
      final controller = QuizController(
        client: ref.read(quizClientProvider),
        progressStore: ref.read(quizProgressStoreProvider),
        studentId: studentId,
      )..addListener(_onChange);
      _controller = controller;
      controller.restore();
    }
  }

  void _onChange() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    _controller?.removeListener(_onChange);
    _controller?.dispose();
    super.dispose();
  }

  Future<void> _confirmNewQuiz(QuizController controller) async {
    final state = controller.state;
    if (state is QuizSetup) return;

    final confirmed = state is QuizRoundResults
        ? true
        : await showDialog<bool>(
                context: context,
                builder: (context) => AlertDialog(
                  title: Text('quiz.abandon.title'.tr()),
                  content: Text('quiz.abandon.body'.tr()),
                  actions: [
                    TextButton(
                      onPressed: () => Navigator.of(context).pop(false),
                      child: Text('quiz.abandon.cancel'.tr()),
                    ),
                    TextButton(
                      onPressed: () => Navigator.of(context).pop(true),
                      child: Text('quiz.abandon.confirm'.tr()),
                    ),
                  ],
                ),
              ) ??
              false;

    if (confirmed) await controller.startNewQuiz();
  }

  @override
  Widget build(BuildContext context) {
    final controller = _controller;

    return Scaffold(
      appBar: AppBar(
        title: Text('quiz.title'.tr()),
        actions: [
          if (controller != null)
            IconButton(
              onPressed: () => _confirmNewQuiz(controller),
              icon: const Icon(Icons.refresh),
              tooltip: 'quiz.newQuiz'.tr(),
            ),
        ],
      ),
      body: controller == null ? const _SignedOutNotice() : _Body(controller: controller),
    );
  }
}

class _Body extends StatelessWidget {
  const _Body({required this.controller});

  final QuizController controller;

  @override
  Widget build(BuildContext context) {
    final state = controller.state;

    return switch (state) {
      QuizSetup() => QuizSetupView(
        state: state,
        onGenerate: (materialIds, questionCount) =>
            controller.generate(materialIds: materialIds, questionCount: questionCount),
      ),
      QuizInProgress() => QuizQuestionView(
        quiz: state.quiz,
        attempt: state.attempt,
        isGrading: state.isGrading,
        gradeFailed: state.gradeFailed,
        onSubmit: controller.submitAnswer,
        onNext: controller.next,
        onRetryGrade: controller.retryGrade,
        onEndNow: controller.endRoundNow,
      ),
      QuizRoundResults() => QuizResultsView(
        quiz: state.quiz,
        attempt: state.attempt,
        onRetryWrongOnly: controller.retryWrongOnly,
        onStartNewQuiz: controller.startNewQuiz,
      ),
    };
  }
}

class _SignedOutNotice extends StatelessWidget {
  const _SignedOutNotice();

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.lock_outline, size: 32, color: colorScheme.onSurfaceVariant),
            const SizedBox(height: 12),
            Text(
              'quiz.signedOut'.tr(),
              textAlign: TextAlign.center,
              style: TextStyle(color: colorScheme.onSurfaceVariant),
            ),
          ],
        ),
      ),
    );
  }
}
