import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/ask_ai_controller.dart';

const double _sendButtonSize = 40;

/// Gap between the field's border and the send button, kept even on every side.
const double _fieldInset = 6;

/// How close to [askAiQuestionMaxChars] a question gets before the character counter appears.
const int _counterThreshold = askAiQuestionMaxChars - 200;

/// The question input bar: a rounded multiline field with the send button tucked inside it.
/// Owns its own [TextEditingController] and clears it once a question is handed off.
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
  void initState() {
    super.initState();
    // Repaints the field border on focus changes.
    _focusNode.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _controller.dispose();
    _focusNode.dispose();
    super.dispose();
  }

  bool get _canSend =>
      widget.enabled && _controller.text.trim().isNotEmpty && _controller.text.trim().length <= askAiQuestionMaxChars;

  void _send() {
    if (!_canSend) return;
    widget.onSend(_controller.text);
    _controller.clear();
    _focusNode.requestFocus();
    setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final length = _controller.text.trim().length;
    final overLimit = length > askAiQuestionMaxChars;
    final borderColor = overLimit
        ? colorScheme.error
        : _focusNode.hasFocus
        ? colorScheme.primary
        : colorScheme.outlineVariant;

    return DecoratedBox(
      decoration: BoxDecoration(
        color: colorScheme.surfaceContainerHighest,
        border: Border(top: BorderSide(color: colorScheme.outlineVariant)),
      ),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(
            AppSpacing.space12,
            AppSpacing.space8,
            AppSpacing.space12,
            AppSpacing.space8,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              AnimatedContainer(
                duration: const Duration(milliseconds: 150),
                padding: const EdgeInsetsDirectional.fromSTEB(
                  AppSpacing.space16,
                  _fieldInset,
                  _fieldInset,
                  _fieldInset,
                ),
                decoration: BoxDecoration(
                  color: widget.enabled ? colorScheme.surface : colorScheme.surfaceContainerHighest,
                  borderRadius: BorderRadius.circular(24),
                  border: Border.all(color: borderColor, width: _focusNode.hasFocus ? 1.5 : 1),
                ),
                child: Row(
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
                        textCapitalization: TextCapitalization.sentences,
                        onChanged: (_) => setState(() {}),
                        decoration: InputDecoration(
                          hintText: 'askAi.composer.hint'.tr(),
                          filled: false,
                          border: InputBorder.none,
                          enabledBorder: InputBorder.none,
                          focusedBorder: InputBorder.none,
                          disabledBorder: InputBorder.none,
                          isDense: true,
                          // One line of text plus this padding is exactly [_sendButtonSize] tall, so
                          // the bottom-aligned button sits centred on a single line and stays by
                          // the last line once the question wraps.
                          contentPadding: const EdgeInsets.symmetric(vertical: AppSpacing.space8),
                        ),
                      ),
                    ),
                    const SizedBox(width: AppSpacing.space4),
                    _SendButton(enabled: _canSend, busy: !widget.enabled, onPressed: _send),
                  ],
                ),
              ),
              if (overLimit || length >= _counterThreshold)
                Padding(
                  padding: const EdgeInsetsDirectional.only(
                    start: AppSpacing.space16,
                    end: AppSpacing.space16,
                    top: AppSpacing.space4,
                  ),
                  child: Row(
                    children: [
                      if (overLimit)
                        Expanded(
                          child: Text(
                            'askAi.composer.tooLong'.tr(),
                            style: theme.textTheme.bodySmall?.copyWith(color: colorScheme.error),
                          ),
                        )
                      else
                        const Spacer(),
                      Text(
                        '$length / $askAiQuestionMaxChars',
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: overLimit ? colorScheme.error : colorScheme.onSurfaceVariant,
                          fontFeatures: const [FontFeature.tabularFigures()],
                        ),
                      ),
                    ],
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// A round send button inside the field. While an answer streams ([busy]) it shows a small
/// spinner rather than a dead greyed-out arrow.
class _SendButton extends StatelessWidget {
  const _SendButton({required this.enabled, required this.busy, required this.onPressed});

  final bool enabled;
  final bool busy;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    return SizedBox.square(
      dimension: _sendButtonSize,
      child: IconButton.filled(
        onPressed: enabled ? onPressed : null,
        tooltip: 'askAi.composer.send'.tr(),
        padding: EdgeInsets.zero,
        style: IconButton.styleFrom(
          backgroundColor: colorScheme.primary,
          foregroundColor: colorScheme.onPrimary,
          disabledBackgroundColor: colorScheme.outlineVariant,
          disabledForegroundColor: colorScheme.onSurfaceVariant,
        ),
        icon: busy
            ? SizedBox.square(
                dimension: 16,
                child: CircularProgressIndicator(strokeWidth: 2, color: colorScheme.onSurfaceVariant),
              )
            : const Icon(Icons.arrow_upward_rounded, size: 22),
      ),
    );
  }
}
