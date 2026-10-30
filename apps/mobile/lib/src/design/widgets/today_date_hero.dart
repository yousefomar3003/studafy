import 'package:flutter/material.dart';

import '../tokens/app_color_tokens.dart';
import '../tokens/app_radius_tokens.dart';
import '../tokens/app_spacing_tokens.dart';
import 'live_date_header.dart';

/// The home-tab header (student, teacher, attendance officer): [LiveDateHeader] on a card in the
/// brand blue, the same in both themes so its white text always reads.
///
/// [footer] sits under the date inside the same blue card (the student's AI offer). It owns its
/// own top spacing, so a footer that decides to render nothing leaves the card unchanged.
class TodayDateHero extends StatelessWidget {
  const TodayDateHero({this.footer, super.key});

  final Widget? footer;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: const BoxDecoration(
        color: AppColorTokens.accent600,
        borderRadius: AppRadius.xlRadius,
      ),
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const LiveDateHeader(color: AppColorTokens.white),
            ?footer,
          ],
        ),
      ),
    );
  }
}
