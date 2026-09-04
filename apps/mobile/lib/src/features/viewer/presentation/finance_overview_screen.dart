import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/viewer_providers.dart';
import 'widgets/recent_payments_card.dart';

/// The Finance viewer summary: recent payments.
///
/// Only one card, deliberately: the org-wide finance reports (aging, collections vs due) return
/// ERPNext's raw report shape and need real client-side parsing to be useful (see
/// `FinancePaymentsClient`'s doc comment) — a fuller finance summary is future scope, not faked
/// here with a partial report reader.
class FinanceOverviewScreen extends ConsumerWidget {
  const FinanceOverviewScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return RefreshIndicator(
      onRefresh: () async => ref.invalidate(viewerRecentPaymentsProvider),
      child: ListView(
        padding: const EdgeInsets.all(AppSpacing.space16),
        children: const [RecentPaymentsCard()],
      ),
    );
  }
}
