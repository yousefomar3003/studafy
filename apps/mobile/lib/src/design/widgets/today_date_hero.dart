import 'package:flutter/material.dart';

import '../kit/app_hero_card.dart';
import 'live_date_header.dart';

/// The home-tab header (student, teacher, attendance officer): [LiveDateHeader] on the kit's
/// brand-blue [AppHeroCard], the same in both themes so its white text always reads.
///
/// [footer] sits under the date inside the same hero (the student's AI offer). It owns its own
/// top spacing, so a footer that decides to render nothing leaves the card unchanged.
class TodayDateHero extends StatelessWidget {
  const TodayDateHero({this.footer, super.key});

  final Widget? footer;

  @override
  Widget build(BuildContext context) {
    return AppHeroCard(
      footer: footer,
      child: const LiveDateHeader(color: AppHeroCard.foreground),
    );
  }
}
