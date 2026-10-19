import 'dart:async';

import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../tokens/app_radius_tokens.dart';
import '../tokens/app_spacing_tokens.dart';

/// A time-of-day greeting, the weekday, the full date and a live clock, all in the active locale
/// ("Saturday" · "October 17, 2026" · "3:42 PM" / "السبت" · "١٧ أكتوبر ٢٠٢٦" · "٣:٤٢ م").
///
/// Drawn in [color] with no background of its own, for placing on a brand-blue hero card (the
/// student today screen, the parent child switcher). Ticks on each minute boundary so the clock
/// and greeting stay current while the screen is open.
class LiveDateHeader extends StatefulWidget {
  const LiveDateHeader({required this.color, super.key});

  final Color color;

  @override
  State<LiveDateHeader> createState() => _LiveDateHeaderState();
}

class _LiveDateHeaderState extends State<LiveDateHeader> {
  DateTime _now = DateTime.now();
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _scheduleTick();
  }

  void _scheduleTick() {
    final untilNextMinute = Duration(
      seconds: 60 - _now.second,
      milliseconds: -_now.millisecond,
    );
    _timer = Timer(untilNextMinute, () {
      if (!mounted) return;
      setState(() => _now = DateTime.now());
      _scheduleTick();
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final textTheme = theme.textTheme;
    final locale = context.locale.toLanguageTag();
    final onHero = widget.color;
    final time = MediaQuery.alwaysUse24HourFormatOf(context)
        ? DateFormat.Hm(locale)
        : DateFormat.jm(locale);
    final greeting = _Greeting.at(_now);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            // The greeting gives way (ellipsis) before the clock on a narrow screen.
            Expanded(
              child: Align(
                alignment: AlignmentDirectional.centerStart,
                child: _GreetingPill(greeting: greeting, color: onHero),
              ),
            ),
            const SizedBox(width: AppSpacing.space8),
            Icon(
              Icons.schedule_rounded,
              size: 16,
              color: onHero.withValues(alpha: 0.8),
            ),
            const SizedBox(width: AppSpacing.space4),
            Text(
              key: const Key('todayClock'),
              time.format(_now),
              style: textTheme.titleMedium?.copyWith(
                color: onHero,
                fontWeight: FontWeight.w600,
                fontFeatures: const [FontFeature.tabularFigures()],
              ),
            ),
          ],
        ),
        const SizedBox(height: AppSpacing.space16),
        Text(
          DateFormat.EEEE(locale).format(_now),
          style: textTheme.headlineMedium?.copyWith(
            color: onHero,
            fontWeight: FontWeight.w700,
            height: 1.1,
          ),
        ),
        const SizedBox(height: AppSpacing.space4),
        Text(
          DateFormat.yMMMMd(locale).format(_now),
          style: textTheme.bodyLarge?.copyWith(
            color: onHero.withValues(alpha: 0.8),
          ),
        ),
      ],
    );
  }
}

enum _Greeting {
  morning('today.greeting.morning', Icons.wb_sunny_rounded),
  afternoon('today.greeting.afternoon', Icons.wb_twilight_rounded),
  evening('today.greeting.evening', Icons.nightlight_round);

  const _Greeting(this.key, this.icon);

  final String key;
  final IconData icon;

  static _Greeting at(DateTime time) => switch (time.hour) {
    >= 5 && < 12 => morning,
    >= 12 && < 17 => afternoon,
    _ => evening,
  };
}

class _GreetingPill extends StatelessWidget {
  const _GreetingPill({required this.greeting, required this.color});

  final _Greeting greeting;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.16),
        borderRadius: AppRadius.fullRadius,
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.space12,
          vertical: AppSpacing.space4,
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(greeting.icon, size: 14, color: color),
            const SizedBox(width: AppSpacing.space8),
            Flexible(
              child: Text(
                greeting.key.tr(),
                overflow: TextOverflow.ellipsis,
                maxLines: 1,
                style: Theme.of(context).textTheme.labelMedium?.copyWith(
                  color: color,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
