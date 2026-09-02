import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/parent_providers.dart';
import 'parent_section_card.dart';

/// The selected child's outstanding fees, drawn from the household financial view. Its own
/// [familyFinanceProvider] watch, so a finance-service outage shows here alone and never blanks
/// the attendance or grades cards.
class ChildFeesCard extends ConsumerWidget {
  const ChildFeesCard({required this.studentId, super.key});

  final String studentId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;

    return ParentSectionCard(
      titleKey: 'parent.fees.title',
      icon: Icons.account_balance_wallet_outlined,
      child: ref.watch(familyFinanceProvider).when(
            loading: () => const ParentCardSkeleton(lineCount: 2),
            error: (_, _) => const ParentCardMessage(
              messageKey: 'parent.fees.error',
              icon: Icons.error_outline,
            ),
            data: (view) {
              if (view == null) {
                return const ParentCardMessage(
                  messageKey: 'parent.fees.empty',
                  icon: Icons.info_outline,
                );
              }
              final due = view.amountsDueFor(studentId);
              if (due.isEmpty) {
                return const ParentCardMessage(
                  messageKey: 'parent.fees.settled',
                  icon: Icons.check_circle_outline,
                );
              }
              return Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  for (final total in due)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: AppSpacing.space4),
                      child: Text(
                        'parent.fees.due'.tr(namedArgs: {'amount': total.label}),
                        style: textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600),
                      ),
                    ),
                  if (view.dataAsOf case final asOf?) ...[
                    const SizedBox(height: AppSpacing.space4),
                    Text(
                      'parent.fees.asOf'.tr(namedArgs: {
                        'date': MaterialLocalizations.of(context)
                            .formatMediumDate(asOf.toLocal()),
                      }),
                      style: textTheme.bodySmall
                          ?.copyWith(color: colorScheme.onSurfaceVariant),
                    ),
                  ],
                ],
              );
            },
          ),
    );
  }
}
