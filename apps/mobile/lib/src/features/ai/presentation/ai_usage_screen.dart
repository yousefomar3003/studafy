import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/ai_hub_providers.dart';
import '../domain/ai_hub_status.dart';
import '../domain/ai_usage.dart';
import 'widgets/ai_hub_message.dart';
import 'widgets/ai_school_inactive_notice.dart';
import 'widgets/ai_state_page.dart';
import 'widgets/ai_upsell_card.dart';
import 'widgets/ai_usage_meter.dart';
import 'widgets/ai_usage_warning_banner.dart';

/// The AI usage meter's own screen (ST-233): [AiUsageMeter]'s full detail -- remaining monthly
/// budget, reset date -- plus, once usage is nearing its limit, a warning shown ahead of the hard
/// stop every generation endpoint already enforces (`AI_QUOTA_EXCEEDED`; see
/// `AiStudyError.quotaExceeded` in `../domain/ai_study.dart`). Reached by tapping the compact
/// meter embedded in `AiHubScreen`.
///
/// Deliberately has no per-feature consumption breakdown: `GET /api/ai/usage` (and the durable
/// ledger behind it, `app.ai_usage_meters` -- see `db/migrations/000106_add_ai_usage_tier_breakdown.sql`)
/// reports only a monthly token total and a small/large model-tier split, never a per-feature
/// one. No AI route records which of `AiFeature`'s cases (ask, quiz, exam, ...) a token was spent
/// on, so there is nothing true to show there yet -- adding it is a backend change (a feature
/// column on the ledger, plus every AI route tagging its own writes), not a mobile-only one.
///
/// Reuses [aiHubStatusProvider] rather than re-fetching: it's the same quota snapshot the hub
/// screen just loaded. Rendering the school-inactive/upsell/unavailable cases with the hub's own
/// widgets (instead of assuming only [AiHubSubscribed] can reach this screen) covers the
/// entitlement lapsing while this screen happens to be open.
class AiUsageScreen extends ConsumerWidget {
  const AiUsageScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final status = ref.watch(aiHubStatusProvider);

    return Scaffold(
      appBar: AppBar(title: Text('ai.usage.title'.tr())),
      body: RefreshIndicator(
        onRefresh: () => ref.refresh(aiHubStatusProvider.future),
        child: status.when(
          // A scrollable ancestor even while loading, same as AiHubScreen -- RefreshIndicator
          // needs one to recognize the pull gesture at all, not just once content has loaded.
          loading: () => ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            children: const [
              Padding(
                padding: EdgeInsets.all(AppSpacing.space48),
                child: Center(child: CircularProgressIndicator()),
              ),
            ],
          ),
          error: (error, stackTrace) =>
              const AiHubMessage(messageKey: 'ai.hub.error', icon: Icons.error_outline),
          data: (value) => switch (value) {
            AiHubUnavailable() => const AiHubMessage(
              messageKey: 'ai.hub.unavailable',
              icon: Icons.info_outline,
            ),
            AiHubSchoolInactive() => const AiStatePage(child: AiSchoolInactiveNotice()),
            AiHubUnsubscribed() => const AiStatePage(child: AiUpsellCard()),
            AiHubSubscribed(:final usage) => AiStatePage(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  AiUsageWarningBanner(level: usage.level),
                  if (usage.level != AiUsageLevel.normal)
                    const SizedBox(height: AppSpacing.space16),
                  AiUsageMeter(usage: usage),
                ],
              ),
            ),
          },
        ),
      ),
    );
  }
}
