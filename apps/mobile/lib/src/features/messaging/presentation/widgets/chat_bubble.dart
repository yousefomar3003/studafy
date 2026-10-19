import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/tokens/app_radius_tokens.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import 'chat_image.dart';

/// Delivery state of a bubble the user sent; null for a confirmed message. Every value but
/// [sending] is a failure, each with its own hint.
enum BubbleDelivery {
  sending,
  failed,
  rateLimited,
  blocked,
  quotaExceeded,
  storageUnavailable,
  invalid;

  bool get isFailure => this != sending;

  String get _hintKey => switch (this) {
    sending => 'messaging.chat.sending',
    failed => 'messaging.chat.failed',
    rateLimited => 'messaging.chat.rateLimited',
    blocked => 'messaging.chat.blocked',
    quotaExceeded => 'messaging.chat.quotaExceeded',
    storageUnavailable => 'messaging.chat.storageUnavailable',
    invalid => 'messaging.chat.invalid',
  };
}

/// One chat message: mine on the trailing side in the primary color, theirs on the leading side
/// on the surface color, with a tighter corner toward the sender's edge. Mirrors in RTL.
///
/// [showTime] adds the time under the bubble (the last of a run from one sender). A failed
/// bubble says so under it and calls [onRetry] when tapped.
///
/// [images] render above the text — one large, or a grid for two to four — each opening
/// [onOpenImage] with its index; [onImageError] fires when a network image fails (an expired
/// URL, usually). An image-only message ([body] empty) has no text area. [onLongPress] (the
/// report action, on the other participant's bubbles) fires on a long press anywhere on it.
class ChatBubble extends StatelessWidget {
  const ChatBubble({
    required this.body,
    required this.createdAt,
    required this.isMine,
    this.showTime = true,
    this.delivery,
    this.onRetry,
    this.images = const [],
    this.onOpenImage,
    this.onImageError,
    this.onLongPress,
    super.key,
  });

  final String body;
  final DateTime createdAt;
  final bool isMine;
  final bool showTime;
  final BubbleDelivery? delivery;
  final VoidCallback? onRetry;
  final List<ChatImage> images;
  final ValueChanged<int>? onOpenImage;
  final VoidCallback? onImageError;
  final VoidCallback? onLongPress;

  /// The width of the image block.
  static const double imagesWidth = 240;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final failed = delivery?.isFailure ?? false;
    const round = Radius.circular(AppRadius.xl);
    const tight = Radius.circular(AppRadius.sm);
    final radius = BorderRadiusDirectional.only(
      topStart: round,
      topEnd: round,
      bottomStart: isMine ? round : tight,
      bottomEnd: isMine ? tight : round,
    );
    final hasText = body.isNotEmpty;

    final bubble = ConstrainedBox(
      constraints: BoxConstraints(maxWidth: MediaQuery.sizeOf(context).width * 0.78),
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: isMine ? colorScheme.primary : colorScheme.surface,
          border: isMine ? null : Border.all(color: colorScheme.outlineVariant),
          borderRadius: radius,
        ),
        child: ClipRRect(
          borderRadius: radius,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (images.isNotEmpty)
                Padding(
                  padding: EdgeInsets.all(hasText ? 2 : 0),
                  child: _ImageGrid(images: images, onOpen: onOpenImage, onError: onImageError),
                ),
              if (hasText)
                Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: AppSpacing.space12,
                    vertical: AppSpacing.space8,
                  ),
                  child: Text(
                    body,
                    style: theme.textTheme.bodyMedium?.copyWith(
                      color: isMine ? colorScheme.onPrimary : colorScheme.onSurface,
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );

    final meta = switch (delivery) {
      final failure? when failure.isFailure => Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.error_outline, size: 14, color: colorScheme.error),
          const SizedBox(width: AppSpacing.space4),
          Flexible(
            child: Text(
              failure._hintKey.tr(),
              style: theme.textTheme.labelSmall?.copyWith(color: colorScheme.error),
            ),
          ),
        ],
      ),
      BubbleDelivery.sending => Text(
        BubbleDelivery.sending._hintKey.tr(),
        style: theme.textTheme.labelSmall?.copyWith(color: colorScheme.onSurfaceVariant),
      ),
      null when showTime => Text(
        DateFormat.jm(context.locale.toString()).format(createdAt.toLocal()),
        style: theme.textTheme.labelSmall?.copyWith(color: colorScheme.onSurfaceVariant),
      ),
      _ => null,
    };

    final content = Column(
      crossAxisAlignment: isMine ? CrossAxisAlignment.end : CrossAxisAlignment.start,
      children: [
        Opacity(opacity: delivery == BubbleDelivery.sending ? 0.7 : 1, child: bubble),
        if (meta != null)
          Padding(
            padding: const EdgeInsets.only(top: AppSpacing.space4),
            child: meta,
          ),
      ],
    );

    return Padding(
      padding: EdgeInsets.only(bottom: meta != null ? AppSpacing.space8 : AppSpacing.space4),
      child: Align(
        alignment: isMine ? AlignmentDirectional.centerEnd : AlignmentDirectional.centerStart,
        child: failed
            ? InkWell(
                onTap: onRetry,
                onLongPress: onLongPress,
                borderRadius: AppRadius.xlRadius,
                child: content,
              )
            : onLongPress != null
            ? GestureDetector(onLongPress: onLongPress, child: content)
            : content,
      ),
    );
  }
}

/// The images of one bubble: one at 4:3, two side by side, three as one wide over two, four as
/// a 2×2 grid. Each tile is a button opening the viewer.
class _ImageGrid extends StatelessWidget {
  const _ImageGrid({required this.images, required this.onOpen, required this.onError});

  final List<ChatImage> images;
  final ValueChanged<int>? onOpen;
  final VoidCallback? onError;

  static const double _gap = 2;

  Widget _tile(int index, double width, double height) {
    final image = images[index];
    return Semantics(
      container: true,
      button: onOpen != null,
      image: true,
      label: 'messaging.attachments.image'.tr(
        namedArgs: {'index': '${index + 1}', 'count': '${images.length}'},
      ),
      excludeSemantics: true,
      child: GestureDetector(
        onTap: onOpen == null ? null : () => onOpen!(index),
        child: SizedBox(
          width: width,
          height: height,
          child: ChatImageView(key: ValueKey(image.key), image: image, onError: onError),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    const width = ChatBubble.imagesWidth;
    const half = (width - _gap) / 2;
    final count = images.length;
    if (count == 1) return _tile(0, width, width * 3 / 4);
    if (count == 2) {
      return Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          _tile(0, half, half),
          const SizedBox(width: _gap),
          _tile(1, half, half),
        ],
      );
    }
    final rows = <Widget>[];
    var index = 0;
    if (count == 3) {
      rows.add(_tile(index++, width, half));
    }
    while (index < count) {
      final first = index++;
      final second = index < count ? index++ : null;
      if (rows.isNotEmpty) rows.add(const SizedBox(height: _gap));
      rows.add(
        Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            _tile(first, half, half),
            if (second != null) ...[const SizedBox(width: _gap), _tile(second, half, half)],
          ],
        ),
      );
    }
    return Column(mainAxisSize: MainAxisSize.min, children: rows);
  }
}

/// A centered day label between messages from different days: "Today", "Yesterday", else the
/// localized date.
class ChatDaySeparator extends StatelessWidget {
  const ChatDaySeparator({required this.day, required this.now, super.key});

  final DateTime day;
  final DateTime now;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.space12),
      child: Center(
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: theme.colorScheme.surface,
            borderRadius: AppRadius.fullRadius,
          ),
          child: Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: AppSpacing.space12,
              vertical: AppSpacing.space4,
            ),
            child: Text(
              chatDayLabel(day, now, context.locale.toString()),
              style: theme.textTheme.labelSmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// "Today" / "Yesterday" / a localized full date for the local calendar day of [day].
String chatDayLabel(DateTime day, DateTime now, String locale) {
  final local = dateOnly(day.toLocal());
  final today = dateOnly(now.toLocal());
  final difference = today.difference(local).inDays;
  if (difference == 0) return 'messaging.chat.today'.tr();
  if (difference == 1) return 'messaging.chat.yesterday'.tr();
  return DateFormat.yMMMMd(locale).format(local);
}

/// [value]'s calendar day as a UTC midnight — comparable by subtraction without a DST shift
/// turning a one-day gap into 23 hours.
DateTime dateOnly(DateTime value) => DateTime.utc(value.year, value.month, value.day);
