import 'package:dio/dio.dart';
import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';

import '../../../../core/api/api_exception.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/ask_ai_controller.dart';
import '../../application/ask_ai_providers.dart';
import '../../data/ai_photo_text_client.dart';
import 'ask_ai_material_sheet.dart';

const double _sendButtonSize = 40;

/// Gap between the field's border and the send button, kept even on every side.
const double _fieldInset = 6;

/// How close to [askAiQuestionMaxChars] a question gets before the character counter appears.
const int _counterThreshold = askAiQuestionMaxChars - 200;

/// The question input bar: a rounded multiline field with an attach button at its start and the
/// send button tucked inside its end. Owns its own [TextEditingController] and clears it once a
/// question is handed off.
///
/// Attach offers a photo (camera or library), whose text is read on the server and put into the
/// field for the student to check before sending, and a material to ask about, shown as a chip
/// above the field until it is removed.
class AskAiComposer extends ConsumerStatefulWidget {
  const AskAiComposer({
    required this.enabled,
    required this.onSend,
    this.materialScope,
    this.onMaterialScopeChanged,
    super.key,
  });

  /// False while an answer is streaming — the field and buttons are disabled then.
  final bool enabled;
  final ValueChanged<String> onSend;

  /// The material questions are limited to, or null for every material.
  final AskAiMaterialScope? materialScope;

  /// Called with the material the student picks, or null when they remove it. Without it the
  /// attach menu offers photos only.
  final ValueChanged<AskAiMaterialScope?>? onMaterialScopeChanged;

  @override
  ConsumerState<AskAiComposer> createState() => _AskAiComposerState();
}

enum _Attachment { camera, gallery, material }

class _AskAiComposerState extends ConsumerState<AskAiComposer> {
  final _controller = TextEditingController();
  final _focusNode = FocusNode();
  bool _readingPhoto = false;

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

  Future<void> _attach() async {
    final choice = await showModalBottomSheet<_Attachment>(
      context: context,
      showDragHandle: true,
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.photo_camera_outlined),
              title: Text('askAi.attach.camera'.tr()),
              onTap: () => Navigator.of(context).pop(_Attachment.camera),
            ),
            ListTile(
              leading: const Icon(Icons.photo_library_outlined),
              title: Text('askAi.attach.gallery'.tr()),
              onTap: () => Navigator.of(context).pop(_Attachment.gallery),
            ),
            if (widget.onMaterialScopeChanged != null)
              ListTile(
                leading: const Icon(Icons.menu_book_outlined),
                title: Text('askAi.attach.material'.tr()),
                subtitle: Text('askAi.attach.materialHint'.tr()),
                onTap: () => Navigator.of(context).pop(_Attachment.material),
              ),
          ],
        ),
      ),
    );
    if (!mounted || choice == null) return;
    switch (choice) {
      case _Attachment.camera:
        await _readPhoto(ImageSource.camera);
      case _Attachment.gallery:
        await _readPhoto(ImageSource.gallery);
      case _Attachment.material:
        final picked = await showAskAiMaterialSheet(context, current: widget.materialScope);
        if (picked != null) widget.onMaterialScopeChanged?.call(picked);
    }
  }

  /// Picks a photo, has the server read its text, and puts that text into the field — after
  /// whatever the student already typed — for them to check and send.
  Future<void> _readPhoto(ImageSource source) async {
    final bytes = await ref.read(aiPhotoPickerProvider).pick(source);
    if (!mounted || bytes == null) return;
    final format = AiPhotoFormat.of(bytes);
    if (format == null) return _notify('askAi.photo.unsupported'.tr());

    setState(() => _readingPhoto = true);
    try {
      final result = await ref.read(aiPhotoTextClientProvider).read(bytes, format);
      if (!mounted) return;
      if (result.text.isEmpty) return _notify('askAi.photo.noText'.tr());

      final typed = _controller.text.trimRight();
      final text = typed.isEmpty ? result.text : '$typed\n\n${result.text}';
      _controller.value = TextEditingValue(
        text: text,
        selection: TextSelection.collapsed(offset: text.length),
      );
      _focusNode.requestFocus();
      if (result.isLowConfidence) {
        _notify('askAi.photo.checkText'.tr());
      } else if (result.truncated) {
        _notify('askAi.photo.truncated'.tr());
      }
    } catch (error) {
      if (mounted) _notify(_photoErrorMessage(error));
    } finally {
      if (mounted) setState(() => _readingPhoto = false);
    }
  }

  String _photoErrorMessage(Object error) {
    final code = switch (error) {
      ApiException(:final code) => code,
      DioException() => error.apiError?.code,
      _ => null,
    };
    return switch (code) {
      'AI_PHOTO_TOO_LARGE' => 'askAi.photo.tooLarge'.tr(),
      'AI_PHOTO_UNSUPPORTED_TYPE' => 'askAi.photo.unsupported'.tr(),
      _ => 'askAi.photo.failed'.tr(),
    };
  }

  void _notify(String message) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
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
              if (widget.materialScope case final scope?)
                Padding(
                  padding: const EdgeInsets.only(bottom: AppSpacing.space8),
                  child: Align(
                    alignment: AlignmentDirectional.centerStart,
                    child: InputChip(
                      avatar: Icon(Icons.menu_book_outlined, size: 18, color: colorScheme.primary),
                      label: Text(
                        'askAi.material.chip'.tr(namedArgs: {'title': scope.title}),
                        overflow: TextOverflow.ellipsis,
                      ),
                      onDeleted: widget.enabled ? () => widget.onMaterialScopeChanged?.call(null) : null,
                      deleteButtonTooltipMessage: 'askAi.material.clear'.tr(),
                    ),
                  ),
                ),
              if (_readingPhoto)
                Padding(
                  padding: const EdgeInsetsDirectional.only(
                    start: AppSpacing.space4,
                    bottom: AppSpacing.space8,
                  ),
                  child: Row(
                    children: [
                      const SizedBox.square(
                        dimension: 14,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      ),
                      const SizedBox(width: AppSpacing.space8),
                      Text(
                        'askAi.photo.reading'.tr(),
                        style: theme.textTheme.bodySmall?.copyWith(color: colorScheme.onSurfaceVariant),
                      ),
                    ],
                  ),
                ),
              AnimatedContainer(
                duration: const Duration(milliseconds: 150),
                padding: const EdgeInsets.all(_fieldInset),
                decoration: BoxDecoration(
                  color: widget.enabled ? colorScheme.surface : colorScheme.surfaceContainerHighest,
                  borderRadius: BorderRadius.circular(24),
                  border: Border.all(color: borderColor, width: _focusNode.hasFocus ? 1.5 : 1),
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    SizedBox.square(
                      dimension: _sendButtonSize,
                      child: IconButton(
                        onPressed: widget.enabled && !_readingPhoto ? _attach : null,
                        tooltip: 'askAi.attach.tooltip'.tr(),
                        padding: EdgeInsets.zero,
                        color: colorScheme.primary,
                        icon: const Icon(Icons.add_circle_outline_rounded, size: 24),
                      ),
                    ),
                    const SizedBox(width: AppSpacing.space4),
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
