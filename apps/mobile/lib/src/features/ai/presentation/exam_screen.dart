import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../application/ask_ai_providers.dart';
import '../application/exam_controller.dart';
import '../application/exam_providers.dart';
import '../domain/exam_state.dart';
import 'widgets/exam_failed_view.dart';
import 'widgets/exam_generating_view.dart';
import 'widgets/exam_player_view.dart';
import 'widgets/exam_ready_view.dart';
import 'widgets/exam_report_view.dart';
import 'widgets/exam_setup_view.dart';

/// Exam mode (ST-232): a timed mock exam over chosen materials — lock-in start, a server-synced
/// countdown, a mixed mcq/short-answer player, one-shot submission, and a scoring report with
/// weak-topic study links.
///
/// Route-only (`/me/exam-mode`), like Quiz and Ask AI. Reuses [askAiStudentIdProvider] — every
/// `/api/ai/*` route takes the same `{studentId}` path convention (the session's own user id).
class ExamScreen extends ConsumerStatefulWidget {
  const ExamScreen({super.key});

  @override
  ConsumerState<ExamScreen> createState() => _ExamScreenState();
}

class _ExamScreenState extends ConsumerState<ExamScreen> {
  ExamController? _controller;

  @override
  void initState() {
    super.initState();
    final studentId = ref.read(askAiStudentIdProvider);
    if (studentId != null) {
      final controller = ExamController(
        client: ref.read(examClientProvider),
        progressStore: ref.read(examProgressStoreProvider),
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

  Future<void> _confirmNewExam(ExamController controller) async {
    final state = controller.state;
    if (state is ExamSetup) return;

    final confirmed = state is ExamSubmitted || state is ExamFailed
        ? true
        : await showDialog<bool>(
                context: context,
                builder: (context) => AlertDialog(
                  title: Text('examMode.abandon.title'.tr()),
                  content: Text('examMode.abandon.body'.tr()),
                  actions: [
                    TextButton(
                      onPressed: () => Navigator.of(context).pop(false),
                      child: Text('examMode.abandon.cancel'.tr()),
                    ),
                    TextButton(
                      onPressed: () => Navigator.of(context).pop(true),
                      child: Text('examMode.abandon.confirm'.tr()),
                    ),
                  ],
                ),
              ) ??
              false;

    if (confirmed) await controller.startNewExam();
  }

  @override
  Widget build(BuildContext context) {
    final controller = _controller;

    return Scaffold(
      appBar: AppBar(
        title: Text('examMode.title'.tr()),
        actions: [
          if (controller != null)
            IconButton(
              onPressed: () => _confirmNewExam(controller),
              icon: const Icon(Icons.refresh),
              tooltip: 'examMode.newExam'.tr(),
            ),
        ],
      ),
      body: controller == null ? const _SignedOutNotice() : _Body(controller: controller),
    );
  }
}

class _Body extends StatelessWidget {
  const _Body({required this.controller});

  final ExamController controller;

  @override
  Widget build(BuildContext context) {
    final state = controller.state;

    return switch (state) {
      ExamSetup() => ExamSetupView(
        state: state,
        onCreate: (materialIds, questionCount, durationMinutes) => controller.create(
          materialIds: materialIds,
          questionCount: questionCount,
          durationMinutes: durationMinutes,
        ),
        onRetryRestore: controller.retryRestore,
      ),
      ExamGenerating() => const ExamGeneratingView(),
      ExamReady() => ExamReadyView(state: state, onStart: controller.start),
      ExamInProgress() => ExamPlayerView(
        state: state,
        remaining: controller.remaining(),
        onAnswer: controller.answer,
        onNext: controller.next,
        onPrevious: controller.previous,
        onSubmit: controller.submit,
      ),
      ExamSubmitted() => ExamReportView(
        report: state.session.report!,
        onStartNew: controller.startNewExam,
      ),
      ExamFailed() => ExamFailedView(onStartNew: controller.startNewExam),
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
              'examMode.signedOut'.tr(),
              textAlign: TextAlign.center,
              style: TextStyle(color: colorScheme.onSurfaceVariant),
            ),
          ],
        ),
      ),
    );
  }
}
