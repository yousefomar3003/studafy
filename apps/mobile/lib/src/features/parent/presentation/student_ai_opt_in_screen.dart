import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../design/kit/kit.dart';
import '../../../design/layout/bottom_inset_padding.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/student_ai_providers.dart';
import 'widgets/parent_section_card.dart';
import 'widgets/student_ai_offer_card.dart';

/// Student AI for the parent's children at this account's school (`/parent/student-ai`): one card
/// per child the school offered it to, to opt in while the school's window is open, or to see what
/// was confirmed. Opened from the parent home's Student AI card and from the `AI_OPTIN_AVAILABLE`
/// and `AI_OPTIN_CONFIRMED` notifications.
class StudentAiOptInScreen extends ConsumerWidget {
  const StudentAiOptInScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final offers = ref.watch(studentAiOffersProvider);

    return Scaffold(
      appBar: AppBar(title: Text('studentAiOptIn.title'.tr())),
      body: RefreshIndicator(
        onRefresh: () => ref.refresh(studentAiOffersProvider.future),
        child: ListView(
          padding: const EdgeInsets.all(AppSpacing.space16).withBottomInset(context),
          physics: const AlwaysScrollableScrollPhysics(),
          children: offers.when(
            loading: () => const [ParentCardSkeleton(lineCount: 5)],
            error: (_, _) => [
              AppEmptyState(
                icon: Icons.error_outline,
                message: 'studentAiOptIn.screen.loadError'.tr(),
                accent: AppEmptyState.accentForIcon(Icons.error_outline),
                action: TextButton(
                  onPressed: () => ref.invalidate(studentAiOffersProvider),
                  child: Text('studentAiOptIn.screen.retry'.tr()),
                ),
              ),
            ],
            data: (data) {
              final list = data?.offers ?? const [];
              if (data == null || list.isEmpty) {
                return [
                  AppEmptyState(
                    icon: Icons.auto_awesome_outlined,
                    message: 'studentAiOptIn.screen.empty'.tr(),
                  ),
                ];
              }
              return [
                Text(
                  'studentAiOptIn.screen.intro'.tr(),
                  style: Theme.of(context).textTheme.bodyMedium,
                ),
                for (final offer in list) ...[
                  const SizedBox(height: AppSpacing.space16),
                  StudentAiOfferCard(
                    key: ValueKey(offer.studentId),
                    offer: offer,
                    termsVersion: data.termsVersion,
                  ),
                ],
              ];
            },
          ),
        ),
      ),
    );
  }
}
