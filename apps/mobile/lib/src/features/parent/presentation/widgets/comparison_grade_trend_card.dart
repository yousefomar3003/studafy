import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../core/api/generated/models/child_comparison_item.dart';
import '../../../../core/api/generated/models/term.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import 'parent_section_card.dart';

/// Every linked child's term-average trend on one chart: one line per child, plotted against
/// [axisTerms] (the terms, in order, that at least one child has a published average for, up to
/// and including the selected term).
///
/// Mirrors the student grades screen's `GradeTrendCard` sparkline — the same fixed 0-100 y-axis,
/// so slope reads as real change rather than an auto-scaled exaggeration, and the same "gap when
/// a term has no published average" rule — but multi-series, since the point here is comparing
/// children against each other rather than one child against their own past.
class ComparisonGradeTrendCard extends StatelessWidget {
  const ComparisonGradeTrendCard({required this.children, required this.axisTerms, super.key});

  final List<ChildComparisonItem> children;
  final List<Term> axisTerms;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    final palette = seriesPalette(colorScheme);

    return ParentSectionCard(
      titleKey: 'parent.comparison.gradeTrend.title',
      icon: Icons.show_chart,
      child: axisTerms.length < 2
          ? Text(
              'parent.comparison.gradeTrend.empty'.tr(),
              style: textTheme.bodyMedium?.copyWith(color: colorScheme.onSurfaceVariant),
            )
          : Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  height: 120,
                  width: double.infinity,
                  child: CustomPaint(
                    painter: _MultiLinePainter(
                      series: [
                        for (var i = 0; i < children.length; i++)
                          _seriesFor(children[i], axisTerms, palette[i % palette.length]),
                      ],
                    ),
                  ),
                ),
                const SizedBox(height: AppSpacing.space12),
                Wrap(
                  spacing: AppSpacing.space12,
                  runSpacing: AppSpacing.space4,
                  children: [
                    for (var i = 0; i < children.length; i++)
                      _LegendEntry(
                        color: palette[i % palette.length],
                        label: children[i].studentName,
                      ),
                  ],
                ),
              ],
            ),
    );
  }

  static _ChartSeries _seriesFor(ChildComparisonItem child, List<Term> axisTerms, Color color) {
    final averageByTermId = {
      for (final point in child.gradeTrend) point.termId: point.termAveragePercentage,
    };
    return _ChartSeries(
      color: color,
      values: [for (final term in axisTerms) averageByTermId[term.id]],
    );
  }
}

/// The fixed color cycle every comparison chart draws its per-child series from, so a child keeps
/// the same color across the grade-trend legend and (were it ever needed) any other chart on this
/// screen. Cycles rather than caps, since a family can link more than four children in principle.
List<Color> seriesPalette(ColorScheme scheme) {
  return [scheme.primary, scheme.tertiary, scheme.secondary, scheme.error];
}

class _ChartSeries {
  const _ChartSeries({required this.color, required this.values});

  final Color color;

  /// One entry per [ComparisonGradeTrendCard.axisTerms] entry, in the same order; null where
  /// this child has no published average for that term.
  final List<num?> values;
}

class _LegendEntry extends StatelessWidget {
  const _LegendEntry({required this.color, required this.label});

  final Color color;
  final String label;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 8,
          height: 8,
          decoration: BoxDecoration(color: color, shape: BoxShape.circle),
        ),
        const SizedBox(width: AppSpacing.space4),
        Text(label, style: Theme.of(context).textTheme.bodySmall),
      ],
    );
  }
}

/// Plots each series left-to-right by [_ChartSeries.values] index on a fixed 0–100 y-axis. A null
/// value breaks the line for that child at that term rather than interpolating across it.
class _MultiLinePainter extends CustomPainter {
  _MultiLinePainter({required this.series});

  final List<_ChartSeries> series;

  @override
  void paint(Canvas canvas, Size size) {
    final pointCount = series.isEmpty ? 0 : series.first.values.length;
    if (pointCount < 2) return;

    const inset = 4.0;
    final usableWidth = size.width - inset * 2;
    final usableHeight = size.height - inset * 2;

    Offset offsetFor(int index, double value) {
      final x = inset + (usableWidth * index / (pointCount - 1));
      final fraction = value.clamp(0, 100).toDouble() / 100;
      final y = inset + usableHeight * (1 - fraction);
      return Offset(x, y);
    }

    for (final line in series) {
      final linePaint = Paint()
        ..color = line.color
        ..strokeWidth = 2
        ..style = PaintingStyle.stroke
        ..strokeCap = StrokeCap.round
        ..strokeJoin = StrokeJoin.round;

      Offset? previous;
      for (var i = 0; i < line.values.length; i++) {
        final value = line.values[i];
        if (value == null) {
          previous = null;
          continue;
        }
        final current = offsetFor(i, value.toDouble());
        if (previous != null) {
          canvas.drawLine(previous, current, linePaint);
        }
        canvas.drawCircle(current, 3, Paint()..color = line.color);
        previous = current;
      }
    }
  }

  // `series` is rebuilt fresh from the report on every build, so a cheap equality check would
  // just do the same per-point comparison the repaint itself does — always repainting is simpler
  // and, for a handful of children over a handful of terms, trivially cheap.
  @override
  bool shouldRepaint(covariant _MultiLinePainter oldDelegate) => true;
}
