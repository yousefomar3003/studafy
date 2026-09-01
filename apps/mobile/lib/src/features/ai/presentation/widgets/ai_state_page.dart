import 'package:flutter/material.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';

/// Common scroll shell for the AI tab's non-loading, non-error states with real content to show --
/// always scrollable so pull-to-refresh keeps working even when [child] is short enough to fit one
/// screen. Shared by `AiHubScreen` and `AiUsageScreen` so both render the school-inactive, upsell,
/// and subscribed states identically.
class AiStatePage extends StatelessWidget {
  const AiStatePage({required this.child, super.key});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(AppSpacing.space16),
      physics: const AlwaysScrollableScrollPhysics(),
      children: [child],
    );
  }
}
