import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../design/tokens/app_radius_tokens.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/ask_ai_providers.dart';
import '../../domain/ask_ai_history.dart';

/// What the student picked in the history sheet.
sealed class AskAiHistoryChoice {
  const AskAiHistoryChoice();
}

/// Start a fresh chat.
class AskAiNewChatChoice extends AskAiHistoryChoice {
  const AskAiNewChatChoice();
}

/// Reopen the conversation [conversationId].
class AskAiOpenChatChoice extends AskAiHistoryChoice {
  const AskAiOpenChatChoice(this.conversationId);
  final String conversationId;
}

/// Opens the Ask AI chat history as a draggable bottom sheet. Resolves to the student's choice, or
/// null when they dismiss it. [currentConversationId] is highlighted as the open chat.
Future<AskAiHistoryChoice?> showAskAiHistorySheet(
  BuildContext context, {
  required String studentId,
  String? currentConversationId,
}) {
  return showModalBottomSheet<AskAiHistoryChoice>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    showDragHandle: true,
    builder: (_) => DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.75,
      minChildSize: 0.4,
      maxChildSize: 0.95,
      builder: (context, scrollController) => _AskAiHistorySheet(
        studentId: studentId,
        currentConversationId: currentConversationId,
        scrollController: scrollController,
      ),
    ),
  );
}

/// The age bucket a conversation is listed under, by when it was last added to.
enum _HistoryGroup { today, yesterday, week, older }

_HistoryGroup _groupFor(DateTime lastMessageAt, DateTime now) {
  final today = DateTime(now.year, now.month, now.day);
  final day = DateTime(
    lastMessageAt.year,
    lastMessageAt.month,
    lastMessageAt.day,
  );
  final daysAgo = today.difference(day).inDays;
  if (daysAgo <= 0) return _HistoryGroup.today;
  if (daysAgo == 1) return _HistoryGroup.yesterday;
  if (daysAgo < 7) return _HistoryGroup.week;
  return _HistoryGroup.older;
}

class _AskAiHistorySheet extends ConsumerStatefulWidget {
  const _AskAiHistorySheet({
    required this.studentId,
    required this.currentConversationId,
    required this.scrollController,
  });

  final String studentId;
  final String? currentConversationId;
  final ScrollController scrollController;

  @override
  ConsumerState<_AskAiHistorySheet> createState() => _AskAiHistorySheetState();
}

class _AskAiHistorySheetState extends ConsumerState<_AskAiHistorySheet> {
  final _conversations = <AskAiConversationSummary>[];
  String? _nextBefore;
  bool _loading = true;
  bool _loadingMore = false;
  bool _failed = false;

  @override
  void initState() {
    super.initState();
    widget.scrollController.addListener(_onScroll);
    _loadFirstPage();
  }

  @override
  void dispose() {
    widget.scrollController.removeListener(_onScroll);
    super.dispose();
  }

  Future<void> _loadFirstPage() async {
    setState(() {
      _loading = true;
      _failed = false;
    });
    try {
      final page = await ref
          .read(askAiHistoryClientProvider)
          .list(studentId: widget.studentId);
      if (!mounted) return;
      setState(() {
        _conversations
          ..clear()
          ..addAll(page.conversations);
        _nextBefore = page.nextBefore;
        _loading = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _failed = true;
      });
    }
  }

  void _onScroll() {
    final position = widget.scrollController.position;
    if (position.pixels >= position.maxScrollExtent - 200) _loadMore();
  }

  Future<void> _loadMore() async {
    final before = _nextBefore;
    if (before == null || _loadingMore || _loading) return;
    setState(() => _loadingMore = true);
    try {
      final page = await ref
          .read(askAiHistoryClientProvider)
          .list(studentId: widget.studentId, before: before);
      if (!mounted) return;
      setState(() {
        _conversations.addAll(page.conversations);
        _nextBefore = page.nextBefore;
      });
    } catch (_) {
      // The list already shown stays usable; scrolling to the end again retries.
    } finally {
      if (mounted) setState(() => _loadingMore = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(
            AppSpacing.space20,
            0,
            AppSpacing.space16,
            AppSpacing.space12,
          ),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  'askAi.history.title'.tr(),
                  style: theme.textTheme.titleLarge,
                ),
              ),
              FilledButton.tonalIcon(
                onPressed: () =>
                    Navigator.of(context).pop(const AskAiNewChatChoice()),
                icon: const Icon(Icons.add_comment_outlined, size: 18),
                label: Text('askAi.history.newChat'.tr()),
              ),
            ],
          ),
        ),
        const Divider(height: 1),
        Expanded(child: _body(context)),
      ],
    );
  }

  Widget _body(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_failed) {
      return _SheetMessage(
        icon: Icons.cloud_off_outlined,
        title: 'askAi.history.error'.tr(),
        action: TextButton(
          onPressed: _loadFirstPage,
          child: Text('askAi.history.retry'.tr()),
        ),
      );
    }
    if (_conversations.isEmpty) {
      return _SheetMessage(
        icon: Icons.forum_outlined,
        title: 'askAi.history.emptyTitle'.tr(),
        body: 'askAi.history.emptyBody'.tr(),
      );
    }

    final now = DateTime.now();
    final rows = <Widget>[];
    _HistoryGroup? group;
    for (final conversation in _conversations) {
      final next = _groupFor(conversation.lastMessageAt, now);
      if (next != group) {
        group = next;
        rows.add(_GroupLabel(label: 'askAi.history.groups.${next.name}'.tr()));
      }
      rows.add(
        _ConversationTile(
          conversation: conversation,
          showTime: next == _HistoryGroup.today,
          selected: conversation.id == widget.currentConversationId,
          onTap: () =>
              Navigator.of(context).pop(AskAiOpenChatChoice(conversation.id)),
        ),
      );
    }
    if (_loadingMore) {
      rows.add(
        const Padding(
          padding: EdgeInsets.all(AppSpacing.space16),
          child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
        ),
      );
    }

    return ListView(
      controller: widget.scrollController,
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.space12,
        AppSpacing.space4,
        AppSpacing.space12,
        AppSpacing.space24,
      ),
      children: rows,
    );
  }
}

class _GroupLabel extends StatelessWidget {
  const _GroupLabel({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsetsDirectional.fromSTEB(
        AppSpacing.space8,
        AppSpacing.space16,
        AppSpacing.space8,
        AppSpacing.space8,
      ),
      child: Text(
        label,
        style: theme.textTheme.labelMedium?.copyWith(
          color: theme.colorScheme.onSurfaceVariant,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}

class _ConversationTile extends StatelessWidget {
  const _ConversationTile({
    required this.conversation,
    required this.showTime,
    required this.selected,
    required this.onTap,
  });

  final AskAiConversationSummary conversation;

  /// Today's chats show the time of day; older ones the date.
  final bool showTime;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final locale = context.locale.toString();
    final when = showTime
        ? DateFormat.jm(locale).format(conversation.lastMessageAt)
        : DateFormat.MMMd(locale).format(conversation.lastMessageAt);
    final questions = 'askAi.history.questions'.plural(
      conversation.messageCount,
    );

    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.space4),
      child: Material(
        color: selected ? colorScheme.primaryContainer : Colors.transparent,
        borderRadius: AppRadius.lgRadius,
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: AppSpacing.space12,
              vertical: AppSpacing.space12,
            ),
            child: Row(
              children: [
                Container(
                  width: 36,
                  height: 36,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: selected
                        ? colorScheme.primary
                        : colorScheme.surfaceContainerHighest,
                  ),
                  child: Icon(
                    selected ? Icons.chat_bubble : Icons.chat_bubble_outline,
                    size: 18,
                    color: selected
                        ? colorScheme.onPrimary
                        : colorScheme.onSurfaceVariant,
                  ),
                ),
                const SizedBox(width: AppSpacing.space12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        conversation.title,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.bodyMedium?.copyWith(
                          fontWeight: FontWeight.w600,
                          color: selected
                              ? colorScheme.onPrimaryContainer
                              : null,
                        ),
                      ),
                      const SizedBox(height: AppSpacing.space4),
                      Text(
                        '$questions · $when',
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: selected
                              ? colorScheme.onPrimaryContainer
                              : colorScheme.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
                if (selected) ...[
                  const SizedBox(width: AppSpacing.space8),
                  Text(
                    'askAi.history.current'.tr(),
                    style: theme.textTheme.labelSmall?.copyWith(
                      color: colorScheme.onPrimaryContainer,
                    ),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _SheetMessage extends StatelessWidget {
  const _SheetMessage({
    required this.icon,
    required this.title,
    this.body,
    this.action,
  });

  final IconData icon;
  final String title;
  final String? body;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 56,
              height: 56,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: colorScheme.surfaceContainerHighest,
              ),
              child: Icon(icon, size: 26, color: colorScheme.onSurfaceVariant),
            ),
            const SizedBox(height: AppSpacing.space16),
            Text(
              title,
              style: theme.textTheme.titleMedium,
              textAlign: TextAlign.center,
            ),
            if (body != null) ...[
              const SizedBox(height: AppSpacing.space8),
              Text(
                body!,
                textAlign: TextAlign.center,
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: colorScheme.onSurfaceVariant,
                ),
              ),
            ],
            if (action != null) ...[
              const SizedBox(height: AppSpacing.space12),
              action!,
            ],
          ],
        ),
      ),
    );
  }
}
