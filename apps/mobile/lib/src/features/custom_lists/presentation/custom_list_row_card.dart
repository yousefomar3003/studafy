import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../design/tokens/app_spacing_tokens.dart';
import '../domain/custom_list.dart';

/// One row of a custom list: who or what it links to, then each filled cell as "label: value". A
/// sensitive cell shows its mask beside a lock -- the full value is revealed only on the web.
class CustomListRowCard extends StatelessWidget {
  const CustomListRowCard({
    required this.row,
    required this.columns,
    this.showLink = true,
    super.key,
  });

  final CustomListRow row;

  /// The list's columns that are not archived, in display order.
  final List<CustomListColumn> columns;

  /// False where the row is shown on the page of the person or class it links to.
  final bool showLink;

  @override
  Widget build(BuildContext context) {
    final language = context.locale.languageCode;
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;
    final link = row.link;
    final yes = 'customLists.yes'.tr();
    final no = 'customLists.no'.tr();

    final lines = <Widget>[
      for (final column in columns)
        if (row.cell(column.id) case final cell?)
          Padding(
            padding: const EdgeInsets.only(top: AppSpacing.space4),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Flexible(
                  child: Text.rich(
                    TextSpan(
                      children: [
                        TextSpan(
                          text: '${column.label(language)}: ',
                          style: textTheme.bodyMedium?.copyWith(
                            color: colorScheme.onSurfaceVariant,
                          ),
                        ),
                        TextSpan(
                          text: cell.display(
                            column,
                            language,
                            yes: yes,
                            no: no,
                          ),
                          style: textTheme.bodyMedium,
                        ),
                      ],
                    ),
                  ),
                ),
                if (cell.masked) ...[
                  const SizedBox(width: AppSpacing.space4),
                  Icon(
                    Icons.lock_outline,
                    size: 16,
                    color: colorScheme.onSurfaceVariant,
                    semanticLabel: 'customLists.list.sensitive'.tr(),
                  ),
                ],
              ],
            ),
          ),
    ];

    return Card(
      margin: const EdgeInsets.only(bottom: AppSpacing.space12),
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (showLink && link != null)
              Text(
                '${link.name ?? 'customLists.list.notVisible'.tr()} · '
                '${'customLists.linkKinds.${link.kind}'.tr()}',
                style: textTheme.titleSmall,
              ),
            if (lines.isEmpty)
              Padding(
                padding: const EdgeInsets.only(top: AppSpacing.space4),
                child: Text(
                  'customLists.list.emptyRow'.tr(),
                  style: textTheme.bodyMedium?.copyWith(
                    color: colorScheme.onSurfaceVariant,
                  ),
                ),
              )
            else
              ...lines,
          ],
        ),
      ),
    );
  }
}
