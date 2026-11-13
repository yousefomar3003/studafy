import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../design/tokens/app_radius_tokens.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../feature_gate.dart';
import '../features_providers.dart';

/// Gates a paid screen on one feature (`docs/billing/feature-licensing.md`, session 6): the screen
/// itself when the person is covered, otherwise the notice for why not -- ask the school for a seat,
/// the school is inactive, Studafy paused it, or [whenPurchasable] (the existing store paywall).
/// A screen with no paywall of its own passes none and gets a plain "not included" notice.
///
/// While the feature list loads, a spinner; if it cannot load, the screen anyway -- the API refuses
/// what the person does not hold, so a failed read never locks out someone who has access.
class FeatureGate extends ConsumerWidget {
  const FeatureGate({
    super.key,
    required this.featureKey,
    required this.child,
    this.whenPurchasable,
  });

  final String featureKey;
  final Widget child;
  final WidgetBuilder? whenPurchasable;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final gate = ref.watch(featureGateProvider(featureKey));
    return gate.when(
      loading: () =>
          const Scaffold(body: Center(child: CircularProgressIndicator())),
      error: (_, _) => child,
      data: (state) => switch (state) {
        FeatureCovered() => child,
        FeaturePurchasable() when whenPurchasable != null => Scaffold(
          appBar: AppBar(),
          body: whenPurchasable!(context),
        ),
        _ => Scaffold(
          appBar: AppBar(),
          body: ListView(
            padding: const EdgeInsets.all(AppSpacing.space16),
            children: [FeatureGateNotice(state: state)],
          ),
        ),
      },
    );
  }
}

/// The card for a feature the person cannot use right now. Never a purchase control: buying lives
/// in the store module's own card, which a screen shows only for [FeaturePurchasable].
class FeatureGateNotice extends StatelessWidget {
  const FeatureGateNotice({super.key, required this.state});

  final FeatureGateState state;

  @override
  Widget build(BuildContext context) {
    final (icon, title, body) = switch (state) {
      FeatureAskSchool(:final schoolName, :final hasSeat) => (
        Icons.school_outlined,
        'features.askSchool.title'.tr(),
        (hasSeat
                ? 'features.askSchool.bodyOtherTier'
                : 'features.askSchool.body')
            .tr(namedArgs: {'school': schoolName}),
      ),
      FeatureSchoolInactive() => (
        Icons.domain_disabled_outlined,
        'features.schoolInactive.title'.tr(),
        'features.schoolInactive.body'.tr(),
      ),
      FeatureUnavailable() => (
        Icons.pause_circle_outline,
        'features.unavailable.title'.tr(),
        'features.unavailable.body'.tr(),
      ),
      FeaturePurchasable(:final expiredOn) => (
        Icons.lock_outline,
        'features.notIncluded.title'.tr(),
        expiredOn != null
            ? 'features.notIncluded.expired'.tr(
                namedArgs: {
                  'date': DateFormat.yMMMd(
                    context.locale.toString(),
                  ).format(expiredOn),
                },
              )
            : 'features.notIncluded.body'.tr(),
      ),
      FeatureCovered() => (Icons.check_circle_outline, '', ''),
    };
    return _NoticeCard(icon: icon, title: title, body: body);
  }
}

/// What a covered feature's screen says about who provides it and how much is left: "Provided by
/// (the school)", the personal subscription that will not renew (with how to turn renewal off in the
/// App Store, where Studafy cannot), and this month's usage or the limit reached. Nothing for a
/// personally covered feature with nothing to count.
class FeatureCoverageBanner extends ConsumerWidget {
  const FeatureCoverageBanner({
    super.key,
    required this.featureKey,
    this.unitKey,
  });

  final String featureKey;

  /// The translation key of the feature's unit (`features.units.messages`...), for usage lines.
  final String? unitKey;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(featureGateProvider(featureKey)).value;
    if (state is! FeatureCovered) return const SizedBox.shrink();
    final date = DateFormat.yMMMd(context.locale.toString());
    final lines = <String>[
      if (state.coverage == FeatureCoverage.school)
        'features.covered.bySchool'.tr(namedArgs: {'school': state.schoolName}),
      if (state.coverage == FeatureCoverage.both) ...[
        'features.covered.bySchool'.tr(namedArgs: {'school': state.schoolName}),
        state.personalEndsAt != null
            ? 'features.covered.bothRenewal'.tr(
                namedArgs: {
                  'date': date.format(state.personalEndsAt!.toLocal()),
                },
              )
            : 'features.covered.bothRenewalNoDate'.tr(),
      ],
      if (state.mustTurnOffAppStoreRenewal)
        'features.covered.appStoreSteps'.tr(),
      if (state.limitReached)
        'features.limit.reached'.tr(
          namedArgs: {'date': date.format(state.resetsOn)},
        )
      else if (state.limit != null && unitKey != null)
        'features.limit.usage'.tr(
          namedArgs: {
            'used': '${state.used}',
            'limit': '${state.limit}',
            'unit': unitKey!.tr(),
          },
        ),
    ];
    if (lines.isEmpty) return const SizedBox.shrink();
    return _NoticeCard(
      icon: state.limitReached
          ? Icons.hourglass_bottom
          : Icons.verified_outlined,
      title: state.limitReached ? 'features.limit.title'.tr() : null,
      body: lines.join('\n\n'),
    );
  }
}

class _NoticeCard extends StatelessWidget {
  const _NoticeCard({required this.icon, required this.body, this.title});

  final IconData icon;
  final String? title;
  final String body;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    return Container(
      padding: const EdgeInsets.all(AppSpacing.space16),
      decoration: BoxDecoration(
        color: colorScheme.surfaceContainerHighest,
        borderRadius: AppRadius.lgRadius,
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, color: colorScheme.onSurfaceVariant),
          const SizedBox(width: AppSpacing.space12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (title != null && title!.isNotEmpty) ...[
                  Text(title!, style: textTheme.titleMedium),
                  const SizedBox(height: AppSpacing.space4),
                ],
                Text(body, style: textTheme.bodyMedium),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
