import 'package:flutter/material.dart';

import '../tokens/app_color_tokens.dart';
import '../tokens/app_radius_tokens.dart';
import '../tokens/app_spacing_tokens.dart';
import 'live_date_header.dart';

/// The home-tab header (student, teacher, attendance officer): [LiveDateHeader] on a card in the
/// brand blue, the same in both themes so its white text always reads.
class TodayDateHero extends StatelessWidget {
  const TodayDateHero({super.key});

  @override
  Widget build(BuildContext context) {
    return const DecoratedBox(
      decoration: BoxDecoration(
        color: AppColorTokens.accent600,
        borderRadius: AppRadius.xlRadius,
      ),
      child: Padding(
        padding: EdgeInsets.all(AppSpacing.space20),
        child: LiveDateHeader(color: AppColorTokens.white),
      ),
    );
  }
}
