import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../design/layout/bottom_inset_padding.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../../parent/presentation/widgets/child_detail_placeholders.dart';
import '../application/messaging_providers.dart';
import '../domain/messaging.dart';
import 'widgets/conversation_tile.dart';

/// "New message" for a teacher: the students they teach, each with the parents the teacher can
/// message about them, narrowed by a search over student and parent names. Tapping a parent
/// resolves the conversation with them — the existing one when there is one (including one the
/// parent started), else a newly created one (`POST /teacher-conversations` is get-or-create
/// either way) — and pops with it; [openTeacherContacts] then opens the chat, so closing the chat
/// lands back on the conversation list. Mirrors [MessagingContactsScreen] on the parent side.
class TeacherMessagingContactsScreen extends ConsumerStatefulWidget {
  const TeacherMessagingContactsScreen({super.key});

  @override
  ConsumerState<TeacherMessagingContactsScreen> createState() =>
      _TeacherMessagingContactsScreenState();
}

class _TeacherMessagingContactsScreenState extends ConsumerState<TeacherMessagingContactsScreen> {
  final _search = TextEditingController();
  String _query = '';

  /// The `studentId/parentId` whose conversation is being opened, to show progress on that row
  /// and ignore further taps meanwhile.
  String? _opening;

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  Future<void> _open(TeacherMessagingStudent student, TeacherMessagingParent parent) async {
    if (_opening != null) return;
    setState(() => _opening = '${student.id}/${parent.parentId}');
    final client = ref.read(messagingClientProvider);
    try {
      final existing = parent.conversationId;
      final conversation = existing != null
          ? await client.getConversation(existing)
          : await client.startTeacherConversation(studentId: student.id, parentId: parent.parentId);
      if (!mounted) return;
      Navigator.of(context).pop(conversation);
    } on Object {
      if (!mounted) return;
      setState(() => _opening = null);
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text('messaging.contacts.startError'.tr())));
    }
  }

  @override
  Widget build(BuildContext context) {
    final contacts = ref.watch(teacherMessagingContactsProvider);

    Future<void> onRefresh() async {
      ref.invalidate(teacherMessagingContactsProvider);
      try {
        await ref.read(teacherMessagingContactsProvider.future);
      } on Object {
        // Surfaced by the list itself.
      }
    }

    return Scaffold(
      appBar: AppBar(title: Text('messaging.teacherContacts.title'.tr())),
      body: RefreshIndicator(
        onRefresh: onRefresh,
        child: contacts.when(
          loading: () => const ChildDetailSkeleton(),
          error: (_, _) => const ChildDetailMessage(
            messageKey: 'messaging.teacherContacts.error',
            icon: Icons.error_outline,
          ),
          data: (students) {
            if (students.isEmpty) {
              return const ChildDetailMessage(
                messageKey: 'messaging.teacherContacts.empty',
                icon: Icons.person_search_outlined,
              );
            }
            final visible = filterTeacherContacts(students, _query);
            return ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: EdgeInsets.zero.withBottomInset(context),
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(
                    AppSpacing.space16,
                    AppSpacing.space16,
                    AppSpacing.space16,
                    AppSpacing.space8,
                  ),
                  child: TextField(
                    controller: _search,
                    onChanged: (value) => setState(() => _query = value),
                    textInputAction: TextInputAction.search,
                    decoration: InputDecoration(
                      prefixIcon: const Icon(Icons.search),
                      hintText: 'messaging.teacherContacts.searchHint'.tr(),
                      border: const OutlineInputBorder(),
                      isDense: true,
                    ),
                  ),
                ),
                if (visible.isEmpty)
                  Padding(
                    padding: const EdgeInsets.all(AppSpacing.space24),
                    child: Text(
                      'messaging.teacherContacts.noMatches'.tr(),
                      textAlign: TextAlign.center,
                    ),
                  ),
                for (final student in visible) ...[
                  _StudentHeader(student: student),
                  for (final parent in student.parents)
                    _ParentTile(
                      parent: parent,
                      opening: _opening == '${student.id}/${parent.parentId}',
                      onTap: _opening == null ? () => _open(student, parent) : null,
                    ),
                ],
              ],
            );
          },
        ),
      ),
    );
  }
}

class _StudentHeader extends StatelessWidget {
  const _StudentHeader({required this.student});

  final TeacherMessagingStudent student;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final classes = student.classes.map((klass) => klass.label).join(' · ');
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.space16,
        AppSpacing.space16,
        AppSpacing.space16,
        AppSpacing.space4,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            student.name,
            style: theme.textTheme.titleSmall?.copyWith(color: theme.colorScheme.primary),
          ),
          if (classes.isNotEmpty)
            Text(
              classes,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant),
            ),
        ],
      ),
    );
  }
}

class _ParentTile extends StatelessWidget {
  const _ParentTile({required this.parent, required this.opening, required this.onTap});

  final TeacherMessagingParent parent;
  final bool opening;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return ListTile(
      leading: MessagingAvatar(name: parent.name),
      title: Text(parent.name),
      subtitle: Text(parent.relationshipKey.tr()),
      trailing: opening
          ? const SizedBox.square(dimension: 20, child: CircularProgressIndicator(strokeWidth: 2))
          : Icon(parent.conversationId != null ? Icons.chat_bubble_outline : Icons.chevron_right),
      onTap: onTap,
    );
  }
}
