import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/kit/kit.dart';

/// A one-line, icon-led message filling a today-screen card's body for any non-loading,
/// non-content state: empty, unavailable, or errored. The three call sites
/// ([TodayGradesCard], [TodayTimetableCard], etc.) only vary the icon and translation key.
///
/// Drawn as the kit's compact [AppEmptyState]; an error (the `error_outline` icon) takes the
/// danger tint so it doesn't read as a calm "nothing here", and an all-done check the success
/// tint ([AppEmptyState.accentForIcon]).
class TodayStateMessage extends StatelessWidget {
  const TodayStateMessage({required this.messageKey, required this.icon, super.key});

  final String messageKey;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    return AppEmptyState(
      compact: true,
      icon: icon,
      message: messageKey.tr(),
      accent: AppEmptyState.accentForIcon(icon),
    );
  }
}
