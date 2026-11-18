import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../design/kit/kit.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/student_ai_providers.dart';
import '../../domain/student_ai_offer.dart';
import '../student_ai_opt_in_screen.dart';
import 'student_ai_offer_card.dart';

/// The parent home's Student AI summary: each child the school offered it to, with where they
/// stand (available, confirmed, waiting for a seat, ended, closed), and the way into
/// [StudentAiOptInScreen]. Shows nothing while it loads, when it fails, or when the school offered
/// it to none of the children, so it never gets in the way of the rest of the home.
class StudentAiHomeCard extends ConsumerWidget {
  const StudentAiHomeCard({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final offers = ref.watch(studentAiOffersProvider).value?.offers ?? const [];
    if (offers.isEmpty) return const SizedBox.shrink();

    void open() => Navigator.of(
      context,
    ).push(MaterialPageRoute<void>(builder: (_) => const StudentAiOptInScreen()));
    final textTheme = Theme.of(context).textTheme;

    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.space16),
      child: AppSectionCard(
        key: const Key('studentAiHomeCard'),
        title: 'studentAiOptIn.title'.tr(),
        icon: Icons.auto_awesome_outlined,
        accent: AppAccent.violet,
        trailing: IconButton(
          icon: const Icon(Icons.arrow_forward),
          tooltip: 'studentAiOptIn.home.open'.tr(),
          onPressed: open,
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('studentAiOptIn.home.intro'.tr(), style: textTheme.bodyMedium),
            for (final offer in offers) ...[
              const SizedBox(height: AppSpacing.space8),
              _ChildRow(offer: offer, onTap: open),
            ],
          ],
        ),
      ),
    );
  }
}

class _ChildRow extends StatelessWidget {
  const _ChildRow({required this.offer, required this.onTap});

  final StudentAiOffer offer;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final status = studentAiStatusOf(offer);
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: AppSpacing.space4),
        child: Row(
          children: [
            Expanded(child: Text(offer.studentName, style: Theme.of(context).textTheme.titleSmall)),
            const SizedBox(width: AppSpacing.space8),
            AppStatusPill(label: status.labelKey.tr(), tone: status.tone),
          ],
        ),
      ),
    );
  }
}
