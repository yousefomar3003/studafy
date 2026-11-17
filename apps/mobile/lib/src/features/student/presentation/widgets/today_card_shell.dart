import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/kit/kit.dart';

/// The common chrome every today-screen card shares: the kit's [AppSectionCard] (coloured icon
/// badge and bold title) over a body [child] that each card fills with its own
/// skeleton/content/empty/error state. [accent] colour-codes the section.
class TodayCardShell extends StatelessWidget {
  const TodayCardShell({
    required this.titleKey,
    required this.icon,
    required this.child,
    this.accent = AppAccent.blue,
    super.key,
  });

  final String titleKey;
  final IconData icon;
  final Widget child;
  final AppAccent accent;

  @override
  Widget build(BuildContext context) {
    return AppSectionCard(title: titleKey.tr(), icon: icon, accent: accent, child: child);
  }
}
