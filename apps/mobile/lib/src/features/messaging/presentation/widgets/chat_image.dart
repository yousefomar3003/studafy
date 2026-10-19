import 'dart:io';

import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../application/messaging_providers.dart';
import '../../domain/messaging.dart';

/// One image in a chat: a confirmed attachment's pre-signed [url] (null when the deployment
/// has no object storage), or the local [filePath] of an image still being sent. [key] stays
/// the same across URL refreshes (the attachment id, or the path).
class ChatImage {
  const ChatImage.network({required this.key, required this.url}) : filePath = null;

  const ChatImage.file(String path) : key = path, url = null, filePath = path;

  final String key;
  final String? url;
  final String? filePath;

  /// The images of a confirmed message, in display order.
  static List<ChatImage> ofMessage(ChatMessage message) => [
    for (final attachment in message.attachments)
      ChatImage.network(key: attachment.id, url: attachment.downloadUrl),
  ];
}

/// Renders a [ChatImage] filling its box, with a placeholder while loading.
///
/// A network image that fails to load is most likely past its five-minute URL: [onError] is
/// called (once per URL, after the frame) so the chat can re-fetch the messages for fresh URLs,
/// and a neutral placeholder stays in the meantime instead of an error. A local file that fails
/// and an attachment with no URL show "Photo unavailable".
class ChatImageView extends StatefulWidget {
  const ChatImageView({required this.image, this.fit = BoxFit.cover, this.onError, super.key});

  final ChatImage image;
  final BoxFit fit;
  final VoidCallback? onError;

  @override
  State<ChatImageView> createState() => _ChatImageViewState();
}

class _ChatImageViewState extends State<ChatImageView> {
  String? _reportedUrl;

  void _reportError(String url) {
    if (_reportedUrl == url) return;
    _reportedUrl = url;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) widget.onError?.call();
    });
  }

  @override
  Widget build(BuildContext context) {
    final image = widget.image;
    if (image.filePath case final path?) {
      return Image.file(
        File(path),
        fit: widget.fit,
        errorBuilder: (context, _, _) => const _Placeholder(unavailable: true),
      );
    }
    final url = image.url;
    if (url == null) return const _Placeholder(unavailable: true);
    return Image.network(
      url,
      key: ValueKey(url),
      fit: widget.fit,
      loadingBuilder: (context, child, progress) => progress == null
          ? child
          : _Placeholder(
              progress: progress.expectedTotalBytes == null
                  ? null
                  : progress.cumulativeBytesLoaded / progress.expectedTotalBytes!,
            ),
      errorBuilder: (context, _, _) {
        _reportError(url);
        return const _Placeholder();
      },
    );
  }
}

class _Placeholder extends StatelessWidget {
  const _Placeholder({this.unavailable = false, this.progress});

  final bool unavailable;
  final double? progress;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    return ColoredBox(
      color: colorScheme.surfaceContainerHighest,
      child: Center(
        child: unavailable
            ? Semantics(
                label: 'messaging.attachments.unavailable'.tr(),
                child: Icon(Icons.broken_image_outlined, color: colorScheme.onSurfaceVariant),
              )
            : progress != null
            ? SizedBox.square(
                dimension: 24,
                child: CircularProgressIndicator(strokeWidth: 2, value: progress),
              )
            : Icon(Icons.image_outlined, color: colorScheme.onSurfaceVariant),
      ),
    );
  }
}

/// Opens [images] full screen at [initialIndex]. For a confirmed message pass its
/// [conversationId] and [messageId]: the viewer then follows the chat's copy of the message, so
/// refreshed URLs reach it, and asks for a refresh when an image fails.
Future<void> openChatImageViewer(
  BuildContext context, {
  required List<ChatImage> images,
  required int initialIndex,
  String? conversationId,
  String? messageId,
}) {
  return Navigator.of(context).push(
    MaterialPageRoute<void>(
      fullscreenDialog: true,
      builder: (_) => ChatImageViewer(
        images: images,
        initialIndex: initialIndex,
        conversationId: conversationId,
        messageId: messageId,
      ),
    ),
  );
}

/// A full-screen, black-backed viewer: pinch to zoom each image ([InteractiveViewer]) and swipe
/// between the message's images (paging pauses while zoomed in).
class ChatImageViewer extends ConsumerStatefulWidget {
  const ChatImageViewer({
    required this.images,
    required this.initialIndex,
    this.conversationId,
    this.messageId,
    super.key,
  });

  final List<ChatImage> images;
  final int initialIndex;
  final String? conversationId;
  final String? messageId;

  @override
  ConsumerState<ChatImageViewer> createState() => _ChatImageViewerState();
}

class _ChatImageViewerState extends ConsumerState<ChatImageViewer> {
  late final PageController _pages = PageController(initialPage: widget.initialIndex);
  late int _index = widget.initialIndex;
  bool _zoomed = false;
  final _transforms = <int, TransformationController>{};

  TransformationController _transformFor(int index) =>
      _transforms.putIfAbsent(index, TransformationController.new);

  @override
  void dispose() {
    _pages.dispose();
    for (final transform in _transforms.values) {
      transform.dispose();
    }
    super.dispose();
  }

  List<ChatImage> _currentImages() {
    final conversationId = widget.conversationId;
    final messageId = widget.messageId;
    if (conversationId == null || messageId == null) return widget.images;
    final messages = ref.watch(chatControllerProvider(conversationId).select((s) => s.messages));
    for (final message in messages) {
      if (message.id == messageId) {
        final images = ChatImage.ofMessage(message);
        return images.length == widget.images.length ? images : widget.images;
      }
    }
    return widget.images;
  }

  @override
  Widget build(BuildContext context) {
    final images = _currentImages();
    final conversationId = widget.conversationId;
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        foregroundColor: Colors.white,
        leading: IconButton(
          tooltip: 'messaging.attachments.viewerClose'.tr(),
          icon: const Icon(Icons.close),
          onPressed: () => Navigator.of(context).maybePop(),
        ),
        title: images.length > 1
            ? Text(
                'messaging.attachments.viewerPosition'.tr(
                  namedArgs: {'index': '${_index + 1}', 'count': '${images.length}'},
                ),
              )
            : null,
      ),
      body: PageView.builder(
        controller: _pages,
        physics: _zoomed ? const NeverScrollableScrollPhysics() : null,
        itemCount: images.length,
        onPageChanged: (index) => setState(() {
          _index = index;
          _zoomed = false;
          for (final transform in _transforms.values) {
            transform.value = Matrix4.identity();
          }
        }),
        itemBuilder: (context, index) => Semantics(
          image: true,
          label: 'messaging.attachments.image'.tr(
            namedArgs: {'index': '${index + 1}', 'count': '${images.length}'},
          ),
          child: InteractiveViewer(
            maxScale: 4,
            transformationController: _transformFor(index),
            onInteractionEnd: (_) =>
                setState(() => _zoomed = _transformFor(index).value.getMaxScaleOnAxis() > 1.01),
            child: Center(
              child: ChatImageView(
                image: images[index],
                fit: BoxFit.contain,
                onError: conversationId == null
                    ? null
                    : () => ref
                          .read(chatControllerProvider(conversationId).notifier)
                          .refreshAttachments(),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
