import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../design/layout/bottom_inset_padding.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/custom_lists_providers.dart';
import 'custom_list_screen.dart';

/// "Lists", opened from Profile by any member of staff: the school's custom lists they may read
/// (bus routes, library loans, lockers), each with who it is shared with and how many rows it has.
/// The API decides which lists by each list's audience. Read-only: lists are made and edited on
/// the web.
class CustomListsScreen extends ConsumerWidget {
  const CustomListsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final lists = ref.watch(customListsProvider);
    final language = context.locale.languageCode;

    return Scaffold(
      appBar: AppBar(title: Text('customLists.title'.tr())),
      body: RefreshIndicator(
        onRefresh: () => ref.refresh(customListsProvider.future),
        child: lists.when(
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (_, _) => ListView(
            padding: const EdgeInsets.all(AppSpacing.space24),
            children: [
              Text('customLists.loadError'.tr(), textAlign: TextAlign.center),
              const SizedBox(height: AppSpacing.space12),
              Center(
                child: OutlinedButton(
                  onPressed: () => ref.invalidate(customListsProvider),
                  child: Text('customLists.retry'.tr()),
                ),
              ),
            ],
          ),
          data: (lists) => ListView(
            padding: const EdgeInsets.all(
              AppSpacing.space16,
            ).withBottomInset(context),
            children: [
              Text(
                'customLists.intro'.tr(),
                style: Theme.of(context).textTheme.bodyMedium,
              ),
              const SizedBox(height: AppSpacing.space16),
              if (lists.isEmpty)
                Text(
                  'customLists.empty'.tr(),
                  key: const Key('customListsEmpty'),
                )
              else
                Card(
                  margin: EdgeInsets.zero,
                  clipBehavior: Clip.antiAlias,
                  child: Column(
                    children: [
                      for (final (index, list) in lists.indexed) ...[
                        if (index > 0) const Divider(height: 1),
                        ListTile(
                          key: Key('customList-${list.id}'),
                          leading: const Icon(Icons.table_rows_outlined),
                          title: Text(list.name(language)),
                          subtitle: Text(
                            '${'customLists.audience.${list.audience}'.tr()} · '
                            '${'customLists.rows'.plural(list.rowCount)}',
                          ),
                          trailing: const Icon(Icons.chevron_right),
                          onTap: () => Navigator.of(context).push(
                            MaterialPageRoute<void>(
                              builder: (_) => CustomListScreen(
                                listId: list.id,
                                title: list.name(language),
                              ),
                            ),
                          ),
                        ),
                      ],
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
