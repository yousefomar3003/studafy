import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/grade_providers.dart';
import '../../domain/grade_trend.dart';

/// The term-average trend: a sparkline of each term's published average across the year, with
/// the currently selected term's point emphasised. Hidden entirely until at least one term has
/// a published summary; shown with an explanatory line until at least two do (a one-point
/// "trend" would be misleading).
class GradeTrendCard extends ConsumerWidget {
  const GradeTrendCard({required this.selectedTermId, super.key});

  final String selectedTermId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;

    final points = [...ref.watch(gradeTrendProvider)]
      ..sort((a, b) => a.termSequenceNumber.compareTo(b.termSequenceNumber));
    final plottable = points.where((p) => p.termAveragePercentage != null).toList();
    if (points.isEmpty) return const SizedBox.shrink();

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.show_chart, size: 20, color: colorScheme.primary),
                const SizedBox(width: AppSpacing.space8),
                Text('grades.trend.title'.tr(), style: textTheme.titleMedium),
              ],
            ),
            const SizedBox(height: AppSpacing.space12),
            if (plottable.length < 2)
              Text(
                'grades.trend.empty'.tr(),
                style: textTheme.bodyMedium?.copyWith(color: colorScheme.onSurfaceVariant),
              )
            else
              _Sparkline(points: points, selectedTermId: selectedTermId),
          ],
        ),
      ),
    );
  }
}

class _Sparkline extends StatelessWidget {
  const _Sparkline({required this.points, required this.selectedTermId});

  final List<GradeTrendPoint> points;
  final String selectedTermId;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final plottable = points.where((p) => p.termAveragePercentage != null).toList();
    final values = plottable.map((p) => p.termAveragePercentage!).toList();
    final lowest = values.reduce((a, b) => a < b ? a : b);
    final highest = values.reduce((a, b) => a > b ? a : b);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          height: 64,
          width: double.infinity,
          child: CustomPaint(
            painter: _SparklinePainter(
              points: points,
              selectedTermId: selectedTermId,
              lineColor: theme.colorScheme.primary,
              pointColor: theme.colorScheme.primary,
              mutedPointColor: theme.colorScheme.outline,
            ),
          ),
        ),
        const SizedBox(height: AppSpacing.space8),
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(
              '${plottable.first.termName} · ${_fmt(plottable.first.termAveragePercentage!)}%',
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            Text(
              '${plottable.last.termName} · ${_fmt(plottable.last.termAveragePercentage!)}%',
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ),
        const SizedBox(height: AppSpacing.space4),
        Text(
          '${_fmt(lowest)}% – ${_fmt(highest)}%',
          style: theme.textTheme.labelSmall?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
      ],
    );
  }

  static String _fmt(double value) {
    final fixed = value.toStringAsFixed(1);
    return fixed.endsWith('.0') ? fixed.substring(0, fixed.length - 2) : fixed;
  }
}

/// Plots [points] left-to-right by term order on a fixed 0–100 y-axis (the domain of a
/// percentage — so the line's slope reads as real change, not an auto-scaled exaggeration).
/// Terms without a published average leave a gap in the line; the selected term's dot is
/// filled and larger.
class _SparklinePainter extends CustomPainter {
  _SparklinePainter({
    required this.points,
    required this.selectedTermId,
    required this.lineColor,
    required this.pointColor,
    required this.mutedPointColor,
  });

  final List<GradeTrendPoint> points;
  final String selectedTermId;
  final Color lineColor;
  final Color pointColor;
  final Color mutedPointColor;

  @override
  void paint(Canvas canvas, Size size) {
    if (points.length < 2) return;

    const inset = 4.0;
    final usableWidth = size.width - inset * 2;
    final usableHeight = size.height - inset * 2;

    Offset offsetFor(int index, double value) {
      final x = inset + (usableWidth * index / (points.length - 1));
      final fraction = value.clamp(0, 100).toDouble() / 100;
      final y = inset + usableHeight * (1 - fraction);
      return Offset(x, y);
    }

    final linePaint = Paint()
      ..color = lineColor
      ..strokeWidth = 2
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;

    Offset? previous;
    for (var i = 0; i < points.length; i++) {
      final value = points[i].termAveragePercentage;
      if (value == null) {
        previous = null;
        continue;
      }
      final current = offsetFor(i, value);
      if (previous != null) {
        canvas.drawLine(previous, current, linePaint);
      }
      previous = current;
    }

    for (var i = 0; i < points.length; i++) {
      final value = points[i].termAveragePercentage;
      if (value == null) continue;
      final center = offsetFor(i, value);
      final isSelected = points[i].termId == selectedTermId;
      canvas.drawCircle(
        center,
        isSelected ? 4.0 : 3.0,
        Paint()
          ..color = isSelected ? pointColor : mutedPointColor
          ..style = isSelected ? PaintingStyle.fill : PaintingStyle.stroke
          ..strokeWidth = 2,
      );
    }
  }

  @override
  bool shouldRepaint(_SparklinePainter oldDelegate) {
    return oldDelegate.selectedTermId != selectedTermId ||
        oldDelegate.points != points ||
        oldDelegate.lineColor != lineColor;
  }
}
