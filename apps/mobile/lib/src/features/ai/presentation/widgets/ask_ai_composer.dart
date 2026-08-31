import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/ask_ai_controller.dart';

/// The question input row: a multiline field and a send button. Owns its own
/// [TextEditingController] and clears it once a question is handed off.
class AskAiComposer extends StatefulWidget {
  const AskAiComposer({required this.enabled, required this.onSend, super.key});

  /// False while an answer is streaming — the field and button are disabled then.
  final bool enabled;
  final ValueChanged<String> onSend;

  @override
  State<AskAiComposer> createState() => _AskAiComposerState();
}

class _AskAiComposerState extends State<AskAiComposer> {
  final _controller = TextEditingController();
  final _focusNode = FocusNode();

  @override
  void dispose() {
    _controller.dispose();
    _focusNode.dispose();
    super.dispose();
  }

  bool get _canSend =>
      widget.enabled &&
      _controller.text.trim().isNotEmpty &&
      _controller.text.trim().length <= askAiQuestionMaxChars;

  void _send() {
    if (!_canSend) return;
    widget.onSend(_controller.text);
    _controller.clear();
    _focusNode.requestFocus();
    setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final overLimit = _controller.text.trim().length > askAiQuestionMaxChars;

    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(
          AppSpacing.space12,
          AppSpacing.space8,
          AppSpacing.space12,
          AppSpacing.space12,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Expanded(
                  child: TextField(
                    controller: _controller,
                    focusNode: _focusNode,
                    enabled: widget.enabled,
                    minLines: 1,
                    maxLines: 5,
                    textInputAction: TextInputAction.newline,
                    onChanged: (_) => setState(() {}),
                    decoration: InputDecoration(
                      hintText: 'askAi.composer.hint'.tr(),
                      border: const OutlineInputBorder(),
                      isDense: true,
                      errorText: overLimit ? 'askAi.composer.tooLong'.tr() : null,
                    ),
                  ),
                ),
                const SizedBox(width: AppSpacing.space8),
                IconButton.filled(
                  onPressed: _canSend ? _send : null,
                  icon: const Icon(Icons.send),
                  tooltip: 'askAi.composer.send'.tr(),
                  style: IconButton.styleFrom(
                    backgroundColor: _canSend ? colorScheme.primary : colorScheme.surfaceContainerHighest,
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
