import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../application/ai_content_report_providers.dart';
import '../../application/ask_ai_providers.dart';
import '../../domain/ai_content_report.dart';

/// The Report action every AI output exposes (ST-306; App Store guideline 1.2, Google Play's
/// generative-AI policy): a flag button that asks why, files the report, and confirms with a
/// snackbar. The server reads the reported content itself, so [target] only names the item.
class AiReportButton extends ConsumerWidget {
  const AiReportButton({required this.target, super.key});

  final AiReportTarget target;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return IconButton(
      onPressed: () => showAiReportFlow(context, ref, target),
      icon: const Icon(Icons.outlined_flag),
      tooltip: 'aiReport.action'.tr(),
    );
  }
}

/// The whole report flow for [target]: reason dialog → `POST .../reports` → outcome snackbar.
/// Also what the Ask AI answer bubble's inline "Report" button calls.
Future<void> showAiReportFlow(BuildContext context, WidgetRef ref, AiReportTarget target) async {
  final studentId = ref.read(askAiStudentIdProvider);
  if (studentId == null) return;

  final submission = await showDialog<AiReportSubmission>(
    context: context,
    builder: (context) => const AiReportDialog(),
  );
  if (submission == null || !context.mounted) return;

  final outcome = await ref
      .read(aiContentReportClientProvider)
      .report(
        studentId: studentId,
        target: target,
        reason: submission.reason,
        details: submission.details,
      );
  if (!context.mounted) return;

  final messageKey = switch (outcome) {
    AiReportOutcome.filed => 'aiReport.filed',
    AiReportOutcome.alreadyFiled => 'aiReport.alreadyFiled',
    AiReportOutcome.failed => 'aiReport.failed',
  };
  ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(messageKey.tr())));
}

/// What the student chose in [AiReportDialog].
class AiReportSubmission {
  const AiReportSubmission({required this.reason, this.details});

  final AiReportReason reason;
  final String? details;
}

/// Asks why the content is being reported (required) and for optional details.
class AiReportDialog extends StatefulWidget {
  const AiReportDialog({super.key});

  @override
  State<AiReportDialog> createState() => _AiReportDialogState();
}

class _AiReportDialogState extends State<AiReportDialog> {
  final _details = TextEditingController();
  AiReportReason? _reason;

  @override
  void dispose() {
    _details.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final reason = _reason;
    return AlertDialog(
      title: Text('aiReport.dialogTitle'.tr()),
      scrollable: true,
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          RadioGroup<AiReportReason>(
            groupValue: reason,
            onChanged: (value) => setState(() => _reason = value),
            child: Column(
              children: [
                for (final option in AiReportReason.values)
                  RadioListTile<AiReportReason>(
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    title: Text('aiReport.reason.${option.name}'.tr()),
                    value: option,
                  ),
              ],
            ),
          ),
          const SizedBox(height: 8),
          TextField(
            controller: _details,
            minLines: 2,
            maxLines: 4,
            maxLength: 1000,
            decoration: InputDecoration(
              hintText: 'aiReport.detailsHint'.tr(),
              border: const OutlineInputBorder(),
            ),
          ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: Text('aiReport.cancel'.tr()),
        ),
        FilledButton(
          onPressed: reason == null
              ? null
              : () => Navigator.of(
                  context,
                ).pop(AiReportSubmission(reason: reason, details: _details.text)),
          child: Text('aiReport.submit'.tr()),
        ),
      ],
    );
  }
}
