import 'dart:io';

import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../../design/tokens/app_radius_tokens.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../domain/draft_attachment.dart';
import '../../domain/messaging.dart';

/// The chat's input: a floating rounded field holding a growing multiline field (up to
/// [maxMessageLength] characters, with a counter only as the limit nears), an attach button and
/// a send button.
///
/// [attachments] (the draft's images) show as a strip of thumbnails above the text — each with a
/// remove button, upload progress, and a failed state that retries on tap. Send is enabled when
/// the trimmed text is non-empty or at least one image is uploaded, and never while one is still
/// uploading. [onSend] gets the raw text; the field clears itself after. [showAttach] shows the
/// attach button, which calls [onAttach] — null disables it (the draft is full).
class ChatComposer extends StatefulWidget {
  const ChatComposer({
    required this.onSend,
    this.attachments = const [],
    this.onAttach,
    this.showAttach = false,
    this.onRemoveAttachment,
    this.onRetryAttachment,
    super.key,
  });

  final ValueChanged<String> onSend;
  final List<DraftAttachment> attachments;
  final VoidCallback? onAttach;
  final bool showAttach;
  final ValueChanged<String>? onRemoveAttachment;
  final ValueChanged<String>? onRetryAttachment;

  @override
  State<ChatComposer> createState() => _ChatComposerState();
}

class _ChatComposerState extends State<ChatComposer> {
  final _controller = TextEditingController();

  /// The counter shows only within this many characters of the limit.
  static const _counterThreshold = 200;

  static const double _sendButtonSize = 44;

  /// Half the single-line height (44px button + 8px padding on each side), so one line is a pill.
  static const BorderRadius _radius = BorderRadius.all(Radius.circular(30));

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  bool get _hasUploaded =>
      widget.attachments.any((attachment) => attachment.status == DraftUploadStatus.uploaded);

  bool get _isUploading =>
      widget.attachments.any((attachment) => attachment.status == DraftUploadStatus.uploading);

  bool _canSend(String text) => !_isUploading && (text.trim().isNotEmpty || _hasUploaded);

  void _send() {
    final text = _controller.text;
    if (!_canSend(text)) return;
    widget.onSend(text);
    _controller.clear();
  }

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;

    // A floating rounded field over the page background (not a full-width bar), with a dark
    // circular send button inside its trailing edge. The radius matches a single-line height so
    // it reads as a pill, and stays a rounded card as the field grows to more lines.
    return SafeArea(
      top: false,
      minimum: const EdgeInsets.only(bottom: AppSpacing.space8),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(
          AppSpacing.space12,
          AppSpacing.space8,
          AppSpacing.space12,
          AppSpacing.space4,
        ),
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: colorScheme.surface,
            borderRadius: _radius,
            border: Border.all(color: colorScheme.outlineVariant),
            boxShadow: [
              BoxShadow(
                color: colorScheme.shadow.withValues(alpha: 0.08),
                blurRadius: 24,
                offset: const Offset(0, 8),
              ),
            ],
          ),
          child: Padding(
            padding: EdgeInsetsDirectional.fromSTEB(
              widget.showAttach ? AppSpacing.space4 : AppSpacing.space20,
              AppSpacing.space8,
              AppSpacing.space8,
              AppSpacing.space8,
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (widget.attachments.isNotEmpty)
                  Padding(
                    padding: const EdgeInsetsDirectional.only(
                      start: AppSpacing.space8,
                      bottom: AppSpacing.space8,
                    ),
                    child: _AttachmentStrip(
                      attachments: widget.attachments,
                      onRemove: widget.onRemoveAttachment,
                      onRetry: widget.onRetryAttachment,
                    ),
                  ),
                Row(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    if (widget.showAttach)
                      IconButton(
                        tooltip: 'messaging.attachments.attach'.tr(),
                        onPressed: widget.onAttach,
                        style: IconButton.styleFrom(fixedSize: const Size.square(_sendButtonSize)),
                        icon: const Icon(Icons.add_photo_alternate_outlined),
                      ),
                    Expanded(
                      child: TextField(
                        controller: _controller,
                        minLines: 1,
                        maxLines: 5,
                        keyboardType: TextInputType.multiline,
                        textCapitalization: TextCapitalization.sentences,
                        maxLength: maxMessageLength,
                        maxLengthEnforcement: MaxLengthEnforcement.enforced,
                        buildCounter:
                            (context, {required currentLength, required isFocused, maxLength}) =>
                                currentLength > maxMessageLength - _counterThreshold
                                ? Text('$currentLength/$maxMessageLength')
                                : null,
                        decoration: InputDecoration(
                          hintText: 'messaging.chat.composerHint'.tr(),
                          isDense: true,
                          filled: false,
                          border: InputBorder.none,
                          enabledBorder: InputBorder.none,
                          focusedBorder: InputBorder.none,
                          contentPadding: const EdgeInsets.symmetric(vertical: AppSpacing.space12),
                        ),
                      ),
                    ),
                    const SizedBox(width: AppSpacing.space8),
                    ValueListenableBuilder<TextEditingValue>(
                      valueListenable: _controller,
                      builder: (context, value, _) => IconButton.filled(
                        tooltip: 'messaging.chat.send'.tr(),
                        onPressed: _canSend(value.text) ? _send : null,
                        style: IconButton.styleFrom(
                          fixedSize: const Size.square(_sendButtonSize),
                          backgroundColor: colorScheme.inverseSurface,
                          foregroundColor: colorScheme.onInverseSurface,
                          disabledBackgroundColor: colorScheme.surfaceContainerHighest,
                          disabledForegroundColor: colorScheme.onSurfaceVariant,
                        ),
                        icon: const Icon(Icons.arrow_upward),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The draft's thumbnails, scrolling sideways.
class _AttachmentStrip extends StatelessWidget {
  const _AttachmentStrip({required this.attachments, this.onRemove, this.onRetry});

  final List<DraftAttachment> attachments;
  final ValueChanged<String>? onRemove;
  final ValueChanged<String>? onRetry;

  static const double _size = 64;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      // Room for the remove button overhanging the top edge.
      height: _size + AppSpacing.space8,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        itemCount: attachments.length,
        separatorBuilder: (_, _) => const SizedBox(width: AppSpacing.space8),
        itemBuilder: (context, index) {
          final attachment = attachments[index];
          return _Thumbnail(
            key: ValueKey(attachment.localId),
            attachment: attachment,
            size: _size,
            onRemove: onRemove == null ? null : () => onRemove!(attachment.localId),
            onRetry: onRetry == null ? null : () => onRetry!(attachment.localId),
          );
        },
      ),
    );
  }
}

class _Thumbnail extends StatelessWidget {
  const _Thumbnail({
    required this.attachment,
    required this.size,
    this.onRemove,
    this.onRetry,
    super.key,
  });

  final DraftAttachment attachment;
  final double size;
  final VoidCallback? onRemove;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final failed = attachment.status == DraftUploadStatus.failed;
    final uploading = attachment.status == DraftUploadStatus.uploading;
    final percent = (attachment.progress * 100).round();

    final String status;
    if (uploading) {
      status = 'messaging.attachments.uploading'.tr(namedArgs: {'percent': '$percent'});
    } else if (failed) {
      status = 'messaging.attachments.failed'.tr();
    } else {
      status = 'messaging.attachments.uploaded'.tr();
    }

    final image = ClipRRect(
      borderRadius: AppRadius.mdRadius,
      child: SizedBox.square(
        dimension: size,
        child: Stack(
          fit: StackFit.expand,
          children: [
            Image.file(
              File(attachment.image.path),
              fit: BoxFit.cover,
              cacheWidth: (size * 3).round(),
              errorBuilder: (context, _, _) => ColoredBox(
                color: colorScheme.surfaceContainerHighest,
                child: Icon(Icons.image_outlined, color: colorScheme.onSurfaceVariant),
              ),
            ),
            if (uploading)
              ColoredBox(
                color: Colors.black38,
                child: Center(
                  child: SizedBox.square(
                    dimension: 28,
                    child: CircularProgressIndicator(
                      strokeWidth: 3,
                      value: attachment.progress > 0 ? attachment.progress : null,
                      color: Colors.white,
                    ),
                  ),
                ),
              ),
            if (failed)
              ColoredBox(
                color: colorScheme.error.withValues(alpha: 0.55),
                child: Center(child: Icon(Icons.refresh, color: colorScheme.onError)),
              ),
          ],
        ),
      ),
    );

    return SizedBox(
      width: size + AppSpacing.space8,
      child: Stack(
        children: [
          PositionedDirectional(
            top: AppSpacing.space8,
            start: 0,
            child: Semantics(
              container: true,
              label: status,
              button: failed,
              excludeSemantics: true,
              child: GestureDetector(onTap: failed ? onRetry : null, child: image),
            ),
          ),
          PositionedDirectional(
            top: 0,
            end: 0,
            child: Semantics(
              container: true,
              button: true,
              label: 'messaging.attachments.remove'.tr(),
              excludeSemantics: true,
              child: Material(
                color: colorScheme.inverseSurface,
                shape: const CircleBorder(),
                child: InkWell(
                  customBorder: const CircleBorder(),
                  onTap: onRemove,
                  child: Padding(
                    padding: const EdgeInsets.all(AppSpacing.space4),
                    child: Icon(Icons.close, size: 14, color: colorScheme.onInverseSurface),
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
