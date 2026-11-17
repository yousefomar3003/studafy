import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../domain/family_finance.dart';

/// One academic year's Student AI line in the Finance tab: `price/month × n months = total,
/// paid with tuition`, with the start month when the child joined late and the month it
/// stopped once the seat was released. The same line whether the school bills it on the fee
/// schedule or itself — the parent pays it with tuition either way. Shows only what the API sends:
/// the parent's own price, never what the school pays for its licence.
class FinanceStudentAiTile extends StatelessWidget {
  const FinanceStudentAiTile({required this.line, super.key});

  final FamilyStudentAiLine line;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;
    final monthFormat = DateFormat.yMMMM(context.locale.toString());
    final months = 'parent.childDetail.finance.studentAi.months'.plural(line.months);

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.space8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'parent.childDetail.finance.studentAi.line'.tr(namedArgs: {
              'price': line.monthlyPriceLabel,
              'months': months,
              'total': line.totalLabel,
            }),
            style: textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: AppSpacing.space4),
          Text(
            [
              line.academicYearName,
              if (line.lateStart)
                'parent.childDetail.finance.studentAi.from'
                    .tr(namedArgs: {'month': monthFormat.format(line.startMonth)}),
              if (line.stoppedFrom case final stopped?)
                'parent.childDetail.finance.studentAi.stoppedFrom'
                    .tr(namedArgs: {'month': monthFormat.format(stopped)}),
            ].join(' · '),
            style: textTheme.bodySmall?.copyWith(color: colorScheme.onSurfaceVariant),
          ),
        ],
      ),
    );
  }
}
