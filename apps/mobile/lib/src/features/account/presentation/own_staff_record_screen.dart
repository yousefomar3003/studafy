import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../design/layout/bottom_inset_padding.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/account_settings_providers.dart';
import '../domain/own_staff_record.dart';

/// "My staff record", opened from Profile by any member of staff: the fields the school keeps about
/// them (a qualification, a contract type), read-only. The school admin fills the record in; the
/// API sends only the fields that are not sensitive, so a salary or a national ID never reaches
/// this screen, masked or otherwise. A document field's file opens through a short-lived URL.
class OwnStaffRecordScreen extends ConsumerStatefulWidget {
  const OwnStaffRecordScreen({super.key});

  @override
  ConsumerState<OwnStaffRecordScreen> createState() =>
      _OwnStaffRecordScreenState();
}

class _OwnStaffRecordScreenState extends ConsumerState<OwnStaffRecordScreen> {
  String? _opening;

  Future<void> _open(OwnRecordEntry entry) async {
    setState(() => _opening = entry.fieldId);
    try {
      final url = await ref.read(ownStaffRecordDocumentUrlProvider)(
        entry.fieldId,
      );
      await launchUrl(url, mode: LaunchMode.externalApplication);
    } on Object {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('account.staffRecord.openFailed'.tr())),
        );
      }
    } finally {
      if (mounted) setState(() => _opening = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final record = ref.watch(ownStaffRecordProvider);

    return Scaffold(
      appBar: AppBar(title: Text('account.staffRecord.title'.tr())),
      body: RefreshIndicator(
        onRefresh: () => ref.refresh(ownStaffRecordProvider.future),
        child: record.when(
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (_, _) => ListView(
            padding: const EdgeInsets.all(AppSpacing.space24),
            children: [
              Text(
                'account.staffRecord.loadError'.tr(),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: AppSpacing.space12),
              Center(
                child: OutlinedButton(
                  onPressed: () => ref.invalidate(ownStaffRecordProvider),
                  child: Text('account.retry'.tr()),
                ),
              ),
            ],
          ),
          data: (record) => ListView(
            padding: const EdgeInsets.all(
              AppSpacing.space16,
            ).withBottomInset(context),
            children: [
              Text(
                'account.staffRecord.intro'.tr(),
                style: Theme.of(context).textTheme.bodyMedium,
              ),
              const SizedBox(height: AppSpacing.space16),
              if (!record.published)
                Text('account.staffRecord.notPublished'.tr())
              else if (record.entries.isEmpty)
                Text('account.staffRecord.empty'.tr())
              else ...[
                if (record.missingRequired > 0) ...[
                  Text(
                    'account.staffRecord.missing'.plural(
                      record.missingRequired,
                    ),
                    key: const Key('ownStaffRecordMissing'),
                  ),
                  const SizedBox(height: AppSpacing.space12),
                ],
                Card(
                  margin: EdgeInsets.zero,
                  clipBehavior: Clip.antiAlias,
                  child: Column(
                    children: [
                      for (final (index, entry) in record.entries.indexed) ...[
                        if (index > 0) const Divider(height: 1),
                        _EntryTile(
                          entry: entry,
                          opening: _opening == entry.fieldId,
                          onOpen: _opening == null ? () => _open(entry) : null,
                        ),
                      ],
                    ],
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _EntryTile extends StatelessWidget {
  const _EntryTile({
    required this.entry,
    required this.opening,
    required this.onOpen,
  });

  final OwnRecordEntry entry;
  final bool opening;
  final VoidCallback? onOpen;

  @override
  Widget build(BuildContext context) {
    final language = context.locale.languageCode;
    final colorScheme = Theme.of(context).colorScheme;
    final file = entry.file;

    final String subtitle;
    if (entry.isDocument) {
      if (file == null || !file.onFile) {
        subtitle = 'account.staffRecord.noFile'.tr();
      } else {
        final parts = [
          file.fileName ?? 'account.staffRecord.fileOnRecord'.tr(),
          if (file.verified) 'account.staffRecord.verified'.tr(),
          if (file.expiresOn != null)
            'account.staffRecord.expires'.tr(
              namedArgs: {'date': file.expiresOn!},
            ),
        ];
        subtitle = parts.join(' · ');
      }
    } else {
      subtitle =
          entry.displayValue(
            language,
            yes: 'account.staffRecord.yes'.tr(),
            no: 'account.staffRecord.no'.tr(),
          ) ??
          'account.staffRecord.notFilledIn'.tr();
    }

    final canOpen = entry.isDocument && file != null && file.onFile;
    return ListTile(
      title: Text(entry.label(language)),
      subtitle: Text(
        subtitle,
        style: entry.missing ? TextStyle(color: colorScheme.error) : null,
      ),
      trailing: !canOpen
          ? null
          : opening
          ? const SizedBox.square(
              dimension: 20,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          : TextButton(
              onPressed: onOpen,
              child: Text(
                'account.staffRecord.open'.tr(),
                semanticsLabel: 'account.staffRecord.openLabel'.tr(
                  namedArgs: {'field': entry.label(language)},
                ),
              ),
            ),
    );
  }
}
