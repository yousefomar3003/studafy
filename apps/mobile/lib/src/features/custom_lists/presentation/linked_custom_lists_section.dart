import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../design/tokens/app_spacing_tokens.dart';
import '../../shell/application/shell_providers.dart';
import '../application/custom_lists_providers.dart';
import 'custom_list_row_card.dart';
import 'custom_list_screen.dart';

/// "Lists" on the page of a student or class: the rows of every custom list the signed-in user may
/// read that link to it, grouped by list, sensitive cells masked. Takes no space at all for someone
/// without `customList:use`, while loading, on an error, or when no list links here -- it is extra
/// information, never in the way of the page it sits on.
class LinkedCustomListsSection extends ConsumerWidget {
  const LinkedCustomListsSection({
    required this.subjectKind,
    required this.subjectId,
    super.key,
  });

  /// `student`, `parent`, `staff` or `class`.
  final String subjectKind;
  final String subjectId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (!canUseCustomLists(ref.watch(sessionRolesProvider))) {
      return const SizedBox.shrink();
    }
    final linked = ref
        .watch(linkedCustomListsProvider((subjectKind, subjectId)))
        .value;
    if (linked == null || linked.isEmpty) return const SizedBox.shrink();

    final language = context.locale.languageCode;
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;

    return Column(
      key: const Key('linkedCustomLists'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text('customLists.linked.title'.tr(), style: textTheme.titleSmall),
        const SizedBox(height: AppSpacing.space8),
        for (final list in linked) ...[
          InkWell(
            onTap: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => CustomListScreen(
                  listId: list.listId,
                  title: list.name(language),
                ),
              ),
            ),
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: AppSpacing.space8),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      list.name(language),
                      style: textTheme.titleSmall?.copyWith(
                        color: colorScheme.primary,
                      ),
                    ),
                  ),
                  Icon(Icons.chevron_right, color: colorScheme.primary),
                ],
              ),
            ),
          ),
          for (final row in list.rows)
            CustomListRowCard(row: row, columns: list.columns, showLink: false),
          if (list.total > list.rows.length)
            Padding(
              padding: const EdgeInsets.only(bottom: AppSpacing.space12),
              child: Text(
                'customLists.linked.more'.plural(list.total - list.rows.length),
                style: textTheme.bodySmall,
              ),
            ),
        ],
      ],
    );
  }
}
