import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

/// Placeholder body for a shell tab whose real feature hasn't shipped yet.
///
/// [titleKey] is a translation key so each tab reads correctly under both the shell's bottom
/// navigation label and its own content — the same string, not duplicated.
class ShellTabPlaceholder extends StatelessWidget {
  const ShellTabPlaceholder({required this.titleKey, super.key});

  final String titleKey;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;

    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(titleKey.tr(), style: textTheme.headlineSmall),
            const SizedBox(height: 8),
            Text(
              'shell.placeholderBody'.tr(),
              style: textTheme.bodyMedium?.copyWith(color: colorScheme.onSurfaceVariant),
              textAlign: TextAlign.center,
            ),
          ],
        ),
      ),
    );
  }
}
