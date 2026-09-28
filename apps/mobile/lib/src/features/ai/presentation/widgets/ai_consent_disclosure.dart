import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../domain/ai_consent.dart';

/// The AI data-sharing disclosure (ST-305): names the third-party provider and lists every kind of
/// data sent to it, exactly as the API serves them. Shared by the consent modal and the
/// data-sharing screen so both always say the same thing.
class AiConsentDisclosure extends StatelessWidget {
  const AiConsentDisclosure({required this.disclosure, super.key});

  final AiDataSharingDisclosure disclosure;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final provider = {'provider': disclosure.providerName};
    final privacyPolicyUrl = disclosure.privacyPolicyUrl;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text('ai.consent.intro'.tr(namedArgs: provider), style: textTheme.bodyMedium),
        const SizedBox(height: AppSpacing.space12),
        for (final category in disclosure.dataCategories)
          Padding(
            padding: const EdgeInsets.only(bottom: AppSpacing.space8),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(category.icon, size: 18),
                const SizedBox(width: AppSpacing.space8),
                Expanded(
                  child: Text(
                    'ai.consent.categories.${category.name}'.tr(),
                    style: textTheme.bodyMedium,
                  ),
                ),
              ],
            ),
          ),
        const SizedBox(height: AppSpacing.space4),
        Text('ai.consent.control'.tr(), style: textTheme.bodySmall),
        if (privacyPolicyUrl != null && privacyPolicyUrl.hasScheme)
          TextButton(
            style: TextButton.styleFrom(padding: EdgeInsets.zero),
            // An informational policy page on the provider's site — no purchase flow.
            onPressed: () => launchUrl(privacyPolicyUrl, mode: LaunchMode.externalApplication),
            child: Text('ai.consent.privacyPolicy'.tr(namedArgs: provider)),
          ),
      ],
    );
  }
}

extension on AiDataCategory {
  IconData get icon => switch (this) {
    AiDataCategory.questions => Icons.chat_bubble_outline,
    AiDataCategory.studyMaterials => Icons.description_outlined,
    AiDataCategory.accountIdentifier => Icons.badge_outlined,
  };
}
