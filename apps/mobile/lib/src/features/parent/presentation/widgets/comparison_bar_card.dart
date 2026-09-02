import 'package:flutter/material.dart';

import '../../../../design/tokens/app_radius_tokens.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import 'parent_section_card.dart';

/// One row of a [ComparisonBarCard]: a child's name, a 0–100 value driving the bar's fill
/// fraction, and the pre-formatted, already-localized label shown at its end.
class ComparisonBarDatum {
  const ComparisonBarDatum({required this.label, required this.value, required this.valueLabel});

  final String label;
  final double value;
  final String valueLabel;
}

/// A side-by-side proportional-bar comparison, one row per linked child. Reused for both the
/// comparison screen's attendance card (present rate) and its assignment-completion card
/// (completion rate) — same shape, different metric and color.
class ComparisonBarCard extends StatelessWidget {
  const ComparisonBarCard({
    required this.titleKey,
    required this.icon,
    required this.data,
    required this.barColor,
    super.key,
  });

  final String titleKey;
  final IconData icon;
  final List<ComparisonBarDatum> data;
  final Color barColor;

  @override
  Widget build(BuildContext context) {
    final trackColor = Theme.of(context).colorScheme.surfaceContainerHighest;

    return ParentSectionCard(
      titleKey: titleKey,
      icon: icon,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (var i = 0; i < data.length; i++) ...[
            if (i > 0) const SizedBox(height: AppSpacing.space12),
            _BarRow(datum: data[i], barColor: barColor, trackColor: trackColor),
          ],
        ],
      ),
    );
  }
}

class _BarRow extends StatelessWidget {
  const _BarRow({required this.datum, required this.barColor, required this.trackColor});

  final ComparisonBarDatum datum;
  final Color barColor;
  final Color trackColor;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final fraction = datum.value.clamp(0, 100).toDouble() / 100;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(child: Text(datum.label, style: textTheme.bodyMedium)),
            Text(
              datum.valueLabel,
              style: textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600),
            ),
          ],
        ),
        const SizedBox(height: AppSpacing.space4),
        ClipRRect(
          borderRadius: AppRadius.smRadius,
          child: LayoutBuilder(
            builder: (context, constraints) => Stack(
              children: [
                Container(height: 8, width: constraints.maxWidth, color: trackColor),
                Container(height: 8, width: constraints.maxWidth * fraction, color: barColor),
              ],
            ),
          ),
        ),
      ],
    );
  }
}
