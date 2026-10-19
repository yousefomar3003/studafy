import 'package:dio/dio.dart';
import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/api/api_exception.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/messaging_providers.dart';
import '../../domain/messaging.dart';

/// How a report sheet closed: [sent] with the block flags after it, or [alreadyOpen] when the
/// caller already has an open report on it (409 `MESSAGE_REPORT_ALREADY_OPEN`). A dismissed
/// sheet returns null.
class ReportSheetResult {
  const ReportSheetResult.sent(BlockState this.block) : alreadyOpen = false;

  const ReportSheetResult.alreadyOpen() : block = null, alreadyOpen = true;

  final BlockState? block;
  final bool alreadyOpen;
}

/// Opens the report sheet for the conversation [conversationId] with [name], or for one of
/// their messages when [messageId] is set. [canBlock] offers "Also block {name}" (false when
/// they are already blocked).
Future<ReportSheetResult?> showReportSheet(
  BuildContext context, {
  required String conversationId,
  required String name,
  String? messageId,
  bool canBlock = true,
}) {
  return showModalBottomSheet<ReportSheetResult>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    showDragHandle: true,
    builder: (_) => ReportSheet(
      conversationId: conversationId,
      name: name,
      messageId: messageId,
      canBlock: canBlock,
    ),
  );
}

/// Pick one of the five reasons, optionally add details (≤ [maxReportDetailsLength]) and
/// optionally block too; submits `POST …/reports` and closes with a [ReportSheetResult]. Any
/// other failure stays in the sheet with an inline error so the user can try again.
class ReportSheet extends ConsumerStatefulWidget {
  const ReportSheet({
    required this.conversationId,
    required this.name,
    this.messageId,
    this.canBlock = true,
    super.key,
  });

  final String conversationId;
  final String name;
  final String? messageId;
  final bool canBlock;

  @override
  ConsumerState<ReportSheet> createState() => _ReportSheetState();
}

class _ReportSheetState extends ConsumerState<ReportSheet> {
  final _details = TextEditingController();
  ReportReason? _reason;
  bool _alsoBlock = false;
  bool _submitting = false;
  bool _failed = false;

  @override
  void dispose() {
    _details.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final reason = _reason;
    if (reason == null || _submitting) return;
    setState(() {
      _submitting = true;
      _failed = false;
    });
    final navigator = Navigator.of(context);
    try {
      final result = await ref
          .read(messagingClientProvider)
          .report(
            widget.conversationId,
            reason: reason,
            messageId: widget.messageId,
            details: _details.text,
            alsoBlock: widget.canBlock && _alsoBlock,
          );
      if (!mounted) return;
      navigator.pop(ReportSheetResult.sent(result.block));
    } on Object catch (error) {
      if (!mounted) return;
      if (error is DioException && error.apiError?.code == 'MESSAGE_REPORT_ALREADY_OPEN') {
        navigator.pop(const ReportSheetResult.alreadyOpen());
        return;
      }
      setState(() {
        _submitting = false;
        _failed = true;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final name = widget.name;
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(
          AppSpacing.space20,
          0,
          AppSpacing.space20,
          AppSpacing.space20,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              widget.messageId == null
                  ? 'messaging.report.title'.tr(namedArgs: {'name': name})
                  : 'messaging.report.messageTitle'.tr(),
              style: theme.textTheme.titleLarge,
            ),
            const SizedBox(height: AppSpacing.space4),
            Text(
              'messaging.report.subtitle'.tr(),
              style: theme.textTheme.bodyMedium?.copyWith(color: colorScheme.onSurfaceVariant),
            ),
            const SizedBox(height: AppSpacing.space16),
            Text('messaging.report.reasonLabel'.tr(), style: theme.textTheme.titleSmall),
            RadioGroup<ReportReason>(
              groupValue: _reason,
              onChanged: (value) {
                if (!_submitting) setState(() => _reason = value);
              },
              child: Column(
                children: [
                  for (final reason in ReportReason.values)
                    RadioListTile<ReportReason>(
                      contentPadding: EdgeInsets.zero,
                      dense: true,
                      value: reason,
                      title: Text('messaging.report.reason.${reason.wire}'.tr()),
                    ),
                ],
              ),
            ),
            const SizedBox(height: AppSpacing.space8),
            TextField(
              controller: _details,
              enabled: !_submitting,
              minLines: 2,
              maxLines: 5,
              maxLength: maxReportDetailsLength,
              textCapitalization: TextCapitalization.sentences,
              decoration: InputDecoration(
                hintText: 'messaging.report.detailsHint'.tr(),
                border: const OutlineInputBorder(),
              ),
            ),
            if (widget.canBlock)
              CheckboxListTile(
                contentPadding: EdgeInsets.zero,
                controlAffinity: ListTileControlAffinity.leading,
                value: _alsoBlock,
                onChanged: _submitting
                    ? null
                    : (value) => setState(() => _alsoBlock = value ?? false),
                title: Text('messaging.report.alsoBlock'.tr(namedArgs: {'name': name})),
              ),
            if (_failed) ...[
              const SizedBox(height: AppSpacing.space8),
              Text(
                'messaging.report.error'.tr(),
                style: theme.textTheme.bodyMedium?.copyWith(color: colorScheme.error),
              ),
            ],
            const SizedBox(height: AppSpacing.space16),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                TextButton(
                  onPressed: _submitting ? null : () => Navigator.of(context).pop(),
                  child: Text('messaging.report.cancel'.tr()),
                ),
                const SizedBox(width: AppSpacing.space8),
                FilledButton(
                  onPressed: _reason == null || _submitting ? null : _submit,
                  child: _submitting
                      ? const SizedBox.square(
                          dimension: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : Text('messaging.report.submit'.tr()),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
