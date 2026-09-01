import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/router/route_paths.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/ai_hub_providers.dart';
import '../domain/ai_hub_status.dart';
import 'widgets/ai_feature_grid.dart';
import 'widgets/ai_hub_message.dart';
import 'widgets/ai_school_inactive_notice.dart';
import 'widgets/ai_state_page.dart';
import 'widgets/ai_upsell_card.dart';
import 'widgets/ai_usage_meter.dart';

/// The AI tab: subscribed feature hub, unsubscribed value explainer + external-browser checkout
/// link, or school-inactive messaging — see [AiHubStatus] for the state each renders and
/// `apps/mobile/docs/ai_store_compliance.md` (R-07) for why purchasing never happens in this app.
///
/// Re-checks entitlement on every app resume (not just first load): a checkout finished in the
/// external browser has no way to call back into this app, so "return -> entitlement reflected
/// without reinstall" (the ticket's acceptance criterion) depends on this screen noticing the app
/// came back to the foreground on its own, rather than the student having to force a refresh.
/// Pull-to-refresh covers the same case manually, and for a transient fetch error.
class AiHubScreen extends ConsumerStatefulWidget {
  const AiHubScreen({super.key});

  @override
  ConsumerState<AiHubScreen> createState() => _AiHubScreenState();
}

class _AiHubScreenState extends ConsumerState<AiHubScreen> with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      ref.invalidate(aiHubStatusProvider);
    }
  }

  @override
  Widget build(BuildContext context) {
    final status = ref.watch(aiHubStatusProvider);

    return Scaffold(
      appBar: AppBar(title: Text('ai.hub.title'.tr())),
      body: RefreshIndicator(
        onRefresh: () => ref.refresh(aiHubStatusProvider.future),
        child: status.when(
          // A scrollable ancestor even while loading, same as every other branch — RefreshIndicator
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
                  AiUsageMeter(
                    usage: usage,
                    onTap: () => GoRouter.of(context).push(RoutePaths.aiUsage),
                  ),
                  const SizedBox(height: AppSpacing.space20),
                  const AiFeatureGrid(),
                ],
              ),
            ),
          },
        ),
      ),
    );
  }
}
