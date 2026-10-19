import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../application/messaging_providers.dart';

/// Decorates the Messages tab's navigation icon with the total unread count. A tear-off of this
/// is what `shellDestinationsFor` hands the shell, keeping the destination list `const`.
Widget unreadMessagesBadge(Widget icon) => UnreadMessagesBadge(child: icon);

/// [child] with a count badge for [unreadMessagesTotalProvider]; just [child] when nothing is
/// unread.
class UnreadMessagesBadge extends ConsumerWidget {
  const UnreadMessagesBadge({required this.child, super.key});

  final Widget child;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final unread = ref.watch(unreadMessagesTotalProvider);
    return Badge.count(count: unread, maxCount: 99, isLabelVisible: unread > 0, child: child);
  }
}
